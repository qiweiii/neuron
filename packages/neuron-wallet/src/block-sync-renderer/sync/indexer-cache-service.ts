import { getConnection } from 'typeorm'
import { queue } from 'async'
import AddressMeta from 'database/address/meta'
import IndexerTxHashCache from 'database/chain/entities/indexer-tx-hash-cache'
import RpcService from 'services/rpc-service'
import TransactionWithStatus from 'models/chain/transaction-with-status'
import { TransactionCollector, CellCollector, CkbIndexer } from '@nervina-labs/ckb-indexer'

export default class IndexerCacheService {
  private addressMetas: AddressMeta[]
  private rpcService: RpcService
  private walletId: string
  private indexer: CkbIndexer

  constructor(walletId: string, addressMetas: AddressMeta[], rpcService: RpcService, indexer: CkbIndexer) {
    for (const addressMeta of addressMetas) {
      if (addressMeta.walletId !== walletId) {
        throw new Error(`address ${addressMeta.address} does not belong to wallet id ${walletId}`)
      }
    }

    this.walletId = walletId
    this.addressMetas = addressMetas
    this.rpcService = rpcService
    this.indexer = indexer
  }

  private async countTxHashes(): Promise<number> {
    return getConnection()
      .getRepository(IndexerTxHashCache)
      .createQueryBuilder()
      .where({
        walletId: this.walletId
      })
      .getCount()
  }

  private async getTxHashes(): Promise<IndexerTxHashCache[]> {
    return getConnection()
      .getRepository(IndexerTxHashCache)
      .createQueryBuilder()
      .where({
        walletId: this.walletId
      })
      .getMany()
  }

  public static async nextUnprocessedBlock(
    walletIds: string[]
  ): Promise<{ blockNumber: string; blockHash: string } | undefined> {
    const result = await getConnection()
      .getRepository(IndexerTxHashCache)
      .createQueryBuilder()
      .where('walletId IN (:...walletIds) and isProcessed = false', { walletIds })
      .orderBy('blockNumber', 'ASC')
      .getOne()

    if (!result) {
      return
    }

    return {
      blockNumber: result.blockNumber.toString(),
      blockHash: result.blockHash
    }
  }

  public static async updateCacheProcessed(txHash: string) {
    await getConnection()
      .createQueryBuilder()
      .update(IndexerTxHashCache)
      .set({
        isProcessed: true
      })
      .where({
        txHash
      })
      .execute()
  }

  private async fetchTxMapping(): Promise<Map<string, Array<{ address: string; lockHash: string }>>> {
    const mappingsByTxHash = new Map()
    for (const addressMeta of this.addressMetas) {
      const lockScripts = [
        addressMeta.generateDefaultLockScript(),
        addressMeta.generateACPLockScript(),
        addressMeta.generateLegacyACPLockScript()
      ]

      for (const lockScript of lockScripts) {
        const transactionCollector = new TransactionCollector(
          this.indexer,
          {
            lock: {
              code_hash: lockScript.codeHash,
              hash_type: lockScript.hashType,
              args: lockScript.args
            }
          },
          this.indexer.ckbRpcUrl,
          {
            includeStatus: false
          }
        )

        const fetchedTxHashes = await transactionCollector.getTransactionHashes()
        //@ts-ignore
        if (!fetchedTxHashes.length) {
          continue
        }

        for (const txHash of fetchedTxHashes) {
          mappingsByTxHash.set(txHash, [
            {
              address: addressMeta.address,
              lockHash: lockScript.computeHash()
            }
          ])
        }
      }

      const lockScriptsForCellCollection = [
        {
          lockScript: addressMeta.generateSingleMultiSignLockScript(),
          argsLen: 28
        },
        {
          lockScript: addressMeta.generateChequeLockScriptWithReceiverLockHash(),
          argsLen: 40
        }
      ]

      for (const { lockScript, argsLen } of lockScriptsForCellCollection) {
        const cellCollector = new CellCollector(this.indexer, {
          lock: {
            code_hash: lockScript.codeHash,
            hash_type: lockScript.hashType,
            args: lockScript.args.slice(0, 42)
          },
          argsLen
        })

        for await (const cell of cellCollector.collect()) {
          const txHash = cell.out_point!.tx_hash!
          mappingsByTxHash.set(txHash, [
            {
              address: addressMeta.address,
              lockHash: lockScript.computeHash()
            }
          ])
        }
      }
    }
    return mappingsByTxHash
  }

  public async upsertTxHashes(): Promise<string[]> {
    const mappingsByTxHash = await this.fetchTxMapping()

    const fetchedTxHashes = [...mappingsByTxHash.keys()]
    const fetchedTxHashCount = fetchedTxHashes.reduce((sum, txHash) => sum + mappingsByTxHash.get(txHash)!.length, 0)

    const txCount = await this.countTxHashes()
    if (fetchedTxHashCount === txCount) {
      return []
    }

    const txMetasCaches = await this.getTxHashes()
    const cachedTxHashes = txMetasCaches.map(meta => meta.txHash.toString())

    const cachedTxHashesSet = new Set(cachedTxHashes)

    const newTxHashes = fetchedTxHashes.filter(hash => !cachedTxHashesSet.has(hash))

    if (!newTxHashes.length) {
      return []
    }

    const txsWithStatus: TransactionWithStatus[] = []
    const fetchBlockDetailsQueue = queue(async (hash: string) => {
      const txWithStatus = await this.rpcService.getTransaction(hash)
      if (!txWithStatus) {
        return
      }
      const blockHeader = await this.rpcService.getHeader(txWithStatus!.txStatus.blockHash!)
      txWithStatus!.transaction.blockNumber = blockHeader!.number
      txWithStatus!.transaction.blockHash = txWithStatus!.txStatus.blockHash!
      txWithStatus!.transaction.timestamp = blockHeader!.timestamp

      txsWithStatus.push(txWithStatus)
    }, 1)

    fetchBlockDetailsQueue.push(newTxHashes)

    await new Promise<void>((resolve, reject) => {
      fetchBlockDetailsQueue.error(reject)
      fetchBlockDetailsQueue.drain(resolve)
    })

    for (const txWithStatus of txsWithStatus) {
      const { transaction, txStatus } = txWithStatus
      const mappings = mappingsByTxHash.get(transaction.hash!)!

      for (const { lockHash, address } of mappings) {
        await getConnection()
          .createQueryBuilder()
          .insert()
          .into(IndexerTxHashCache)
          .values({
            txHash: transaction.hash,
            blockNumber: parseInt(transaction.blockNumber!),
            blockHash: txStatus.blockHash!,
            blockTimestamp: transaction.timestamp,
            lockHash,
            address,
            walletId: this.walletId,
            isProcessed: false
          })
          .execute()
      }
    }

    return newTxHashes
  }

  public async updateProcessedTxHashes(blockNumber: string) {
    await getConnection()
      .createQueryBuilder()
      .update(IndexerTxHashCache)
      .set({
        isProcessed: true
      })
      .where({
        blockNumber: blockNumber,
        walletId: this.walletId
      })
      .execute()
  }

  public async nextUnprocessedTxsGroupedByBlockNumber(): Promise<IndexerTxHashCache[]> {
    const cache = await getConnection()
      .getRepository(IndexerTxHashCache)
      .createQueryBuilder()
      .where({
        isProcessed: false,
        walletId: this.walletId
      })
      .orderBy('blockNumber', 'ASC')
      .getOne()

    if (!cache) {
      return []
    }

    const { blockNumber } = cache
    return await getConnection()
      .getRepository(IndexerTxHashCache)
      .createQueryBuilder()
      .where({
        blockNumber,
        isProcessed: false,
        walletId: this.walletId
      })
      .getMany()
  }
}
