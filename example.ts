import {DataBatcher, Write} from './databatcher.ts'

const example = {1: 'one', 3: 'three'}

async function loadBatch(ids:[number]) {
    // do some fancy work here to fetch all records with the given ids
    // if record is not found for a given id, then return null, or if an error occurs
    return ids.map(id => example[id] || null)
}

async function saveBatch(writes:Write[]) {
  // do something super fancy to perform the writes in batch
  // Returning an Error if something goes wrong
  return writes.map(([key, value])=> {
    example[key] = value
  })
}

async function run() {
    const batcher = new DataBatcher(loadBatch, saveBatch)
    console.log(await batcher.load(1)) // one
    console.log(await batcher.load(2)) // null
    console.log(await batcher.load(3)) // three 
    await batcher.save(2, 'TWO')
    console.log(await batcher.load(2)) // TWO 
}

run()