const isFunction = x => typeof x === "function";
const isUndefined = x => typeof x === "undefined";
const isDefined = x => typeof x !== "undefined";
const isObject = x => typeof x === "object";

export type BatchLoadFn = (keys: any[]) => Promise<any[]>;
export type Write = [any, any];

type WriteResult = Error | void;
export type BatchSaveFn = (write: [Write?]) => Promise<WriteResult[]>;

type DataBatcherOptions = {
  cache?: boolean;
  cacheKeyFn?: (any) => string | number;
  maxBatchSize?: number;
};
type LoadCache = { [key: string]: any };
type BatchOp = {
  key: any;
  value?: any;
  type: "load" | "save";
  resolve: (any?) => void;
  reject: (any?) => void;
};
type BatchQueue = BatchOp[];

export class DataBatcher {
  private batchLoadFn: BatchLoadFn;
  private batchSaveFn: BatchSaveFn;
  private options: DataBatcherOptions;

  private flushing: boolean;
  private queue: BatchQueue;
  private loadCache: LoadCache;

  constructor(
    batchLoadFn: BatchLoadFn,
    batchSaveFn?: BatchSaveFn | DataBatcherOptions,
    options?: DataBatcherOptions
  ) {
    this.batchLoadFn = this.prepareBatchLoadFn(batchLoadFn);
    this.batchSaveFn = this.prepareBatchSaveFn(batchSaveFn, options);
    this.options = this.prepareOptions(batchSaveFn, options);

    this.loadCache = {};
    this.flushing = false;
    this.queue = [];
  }

  prepareBatchLoadFn(batchLoadFn) {
    if (!isFunction(batchLoadFn)) {
      throw new TypeError(
        "DataBatcher must be constructed with a batch load function which accepts " +
          `Array<key> and returns Promise<Array<value>>, but got: ${batchLoadFn}.`
      );
    }

    return batchLoadFn;
  }

  prepareBatchSaveFn(batchSaveFn, options) {
    // second param is options
    if (isUndefined(options) && isObject(batchSaveFn)) {
      return null;
    }

    if (isDefined(batchSaveFn) && !isFunction(batchSaveFn)) {
      throw new TypeError(
        "DataBatcher must be constructed with a batch save function which accepts " +
          `Array<[key,value]> and returns Promise<Array<void>>, but got: ${batchSaveFn}.`
      );
    }

    return batchSaveFn;
  }

  prepareOptions(batchSaveFn, options) {
    if (isUndefined(options) && isObject(batchSaveFn)) {
      options = batchSaveFn;
    }

    return options || {};
  }

  loadMany(keys) {
    return Promise.all(keys.map(this.load.bind(this)));
  }

  load(key) {
    const shouldCache = this.options.cache !== false;
    const cacheKeyFn = this.options.cacheKeyFn;
    const cacheKey = cacheKeyFn ? cacheKeyFn(key) : key;

    if (shouldCache) {
      return (
        this.loadCache[cacheKey] ||
        (this.loadCache[cacheKey] = this._loadLater(key))
      );
    } else {
      return this._loadLater(key);
    }
  }

  _loadLater(key) {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, key, type: "load" });
      if (this.queue.length === 1 && !this.flushing) {
        // process.nextTick(this.flushQueue.bind(this))
        Promise.resolve().then(this.flushQueue.bind(this));
      }
    });
  }

  saveMany(saves) {
    return Promise.all(saves.map(([key, value]) => this.save(key, value)));
  }

  save(key, value) {
    // clear item from load cache
    const cacheKeyFn = this.options.cacheKeyFn;
    const cacheKey = cacheKeyFn ? cacheKeyFn(key) : key;
    delete this.loadCache[cacheKey];

    return this._saveLater(key, value);
  }

  _saveLater(key, value) {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, key, value, type: "save" });
      if (this.queue.length === 1 && !this.flushing) {
        // process.nextTick(this.flushQueue.bind(this))
        Promise.resolve().then(this.flushQueue.bind(this));
      }
    });
  }

  async flushQueue() {
    if (this.queue.length === 0) {
      this.flushing = false;
      return;
    }

    this.flushing = true;

    const queueLength = this.queue.length;
    const maxBatchSize = this.options.maxBatchSize
      ? Math.min(this.options.maxBatchSize, queueLength)
      : queueLength;

    const batchType = this.queue[0].type;

    let batchSize = 1;
    while (
      batchSize < maxBatchSize &&
      this.queue[batchSize].type === batchType
    ) {
      batchSize++;
    }

    const batch = this.queue.splice(0, batchSize);
    if (batchType === "load") {
      await this._batchLoad(batch);
    } /* if (batchType === 'save') */ else {
      await this.batchSave(batch);
    }

    this.flushQueue();
  }

  async _batchLoad(batch) {
    const loadResult = await this._checkLoadResult(
      this.batchLoadFn(batch.map(({ key }) => key)),
      batch.length
    );
    if (loadResult instanceof Error) {
      batch.forEach(({ reject }) => reject(loadResult));
    } else {
      batch.forEach(({ resolve, reject }, index) => {
        const result = loadResult[index];
        return result instanceof Error ? reject(result) : resolve(result);
      });
    }
  }

  async _checkLoadResult(loadResultPromise, expectedLength) {
    if (!loadResultPromise || !loadResultPromise.then) {
      return new Error(
        `batchLoadFn must return Promise<Array<value>> but got: ${loadResultPromise}`
      );
    }

    let loadResult = await loadResultPromise;
    if (!Array.isArray(loadResult)) {
      return new Error(
        `batchLoadFn must return Promise<Array<value>> but got: Promise<${loadResult}>`
      );
    }

    if (loadResult.length !== expectedLength) {
      return new Error(
        `batchLoadFn must return Promise<Array<value>> of length ${expectedLength} but got length: ${
          loadResult.length
        }`
      );
    }

    return loadResult;
  }

  private async batchSave(batch) {
    const saveResult = await this.checkSaveResult(
      this.batchSaveFn(batch.map(({ key, value }) => [key, value])),
      batch.length
    );

    if (saveResult instanceof Error) {
      batch.forEach(({ reject }) => reject(saveResult));
    } else {
      batch.forEach(({ resolve, reject }, index) => {
        const result = saveResult[index];
        return result instanceof Error ? reject(result) : resolve(result);
      });
    }
  }

  private async checkSaveResult(saveResultPromise, expectedLength) {
    if (!saveResultPromise || !saveResultPromise.then) {
      return new Error(
        `batchSaveFn must return Promise<Array<any>> but got: ${saveResultPromise}`
      );
    }

    let saveResult = await saveResultPromise;
    if (!Array.isArray(saveResult)) {
      return new Error(
        `batchSaveFn must return Promise<Array<any>> but got: Promise<${saveResult}>`
      );
    }

    if (saveResult.length !== expectedLength) {
      return new Error(
        `batchSaveFn must return Promise<Array<any>> of length ${expectedLength} but got length: ${
          saveResult.length
        }`
      );
    }

    return saveResult;
  }
}
