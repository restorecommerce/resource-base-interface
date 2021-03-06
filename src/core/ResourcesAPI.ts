import * as _ from 'lodash';
import * as bluebird from 'bluebird';
import { errors } from '@restorecommerce/chassis-srv';
import * as uuid from 'uuid';
import * as redis from 'redis';
import { Topic } from '@restorecommerce/kafka-client';

import { BaseDocument, DocumentMetadata } from './interfaces';
import { DatabaseProvider, GraphDatabaseProvider } from '@restorecommerce/chassis-srv';

bluebird.promisifyAll(redis.RedisClient.prototype);

let redisClient: any;

const Strategies = {
  INCREMENT: 'increment',
  UUID: 'uuid',
  RANDOM: 'random',
  TIMESTAMP: 'timestamp'
};

const uuidGen = (): string => {
  return uuid.v4().replace(/-/g, '');
};

const isEmptyObject = (obj: any): any => {
  return !Object.keys(obj).length;
};

const setDefaults = async (obj: { meta?: DocumentMetadata; [key: string]: any }, collectionName: string): Promise<any> => {
  const o = obj;

  if (_.isEmpty(o.meta)) {
    throw new errors.InvalidArgument('Object does not contain ownership information');
  }

  const now = Date.now();
  if (redisClient) {
    const values: Array<string> = await redisClient.hgetallAsync(collectionName);

    if (values) {
      for (let field in values) {
        const strategy = values[field];
        switch (strategy) {
          case Strategies.INCREMENT:
            const key = collectionName + ':' + field;
            o[field] = await redisClient.getAsync(key);
            await redisClient.incrAsync(key);
            break;
          case Strategies.UUID:
            o[field] = uuidGen();
            break;
          case Strategies.RANDOM:
            o[field] = uuidGen();
            break;
          case Strategies.TIMESTAMP:
            o[field] = await redisClient.timeAsync()[0];
            break;
        }
      }
    }
  }

  if (_.isNil(o.meta.created) || o.meta.created === 0) {
    o.meta.created = now;
  }
  o.meta.modified = now;
  if (_.isNil(o.id) || o.id === 0 || isEmptyObject(o.id)) {
    o.id = uuidGen();
  }
  return o;
};

const updateMetadata = (docMeta: DocumentMetadata, newDoc: BaseDocument): BaseDocument => {
  if (_.isEmpty(newDoc.meta)) {
    // docMeta.owner = newDoc.owner;
    throw new errors.InvalidArgument(`Update request holds no valid metadata for document ${newDoc.id}`);
  }

  if (!_.isEmpty(newDoc.meta.owner)) {
    // if ownership is meant to be updated
    docMeta.owner = newDoc.meta.owner;
  }

  docMeta.modified_by = newDoc.meta.modified_by;
  docMeta.modified = Date.now();

  newDoc.meta = docMeta;
  return newDoc;
};

const decodeBufferObj = (document: BaseDocument, bufferField: string): BaseDocument => {
  if (bufferField in document && !_.isEmpty(document[bufferField])) {
    const encodedBufferObj = document[bufferField].value;
    // By default it was encoded in utf8 so decoding by default from utf8
    let decodedMsg = Buffer.from(encodedBufferObj).toString();
    // store as object in DB
    decodedMsg = JSON.parse(decodedMsg);
    document[bufferField] = decodedMsg;
  }
  return document;
};

const encodeMsgObj = (document: any, bufferField: string): any => {
  if (bufferField in document && document[bufferField]) {
    const decodedMsg = document[bufferField];
    // convert the Msg obj to Buffer Obj
    const encodedBufferObj = Buffer.from(JSON.stringify(decodedMsg));
    document[bufferField] = {};
    document[bufferField].value = encodedBufferObj;
  }
  return document;
};

/**
 * Resource API base provides functions for CRUD operations.
 */
export class ResourcesAPIBase {
  bufferField: string;
  requiredFields: any;
  resourceName: string;
  /**
   * @constructor
   * @param  {object} db Chassis arangodb provider.
   * @param {string} collectionName Name of database collection.
   * @param {any} fieldHandlerConf The collection's field generators configuration.
   */
  constructor(private db: DatabaseProvider, private collectionName: string, fieldHandlerConf?: any,
    private edgeCfg?: any, private graphName?: string) {
    this.resourceName = collectionName.substring(0, collectionName.length - 1);

    if (!fieldHandlerConf) {
      return;
    }

    const strategyCfg = fieldHandlerConf.strategies;
    if (!redisClient) {
      redisClient = fieldHandlerConf.redisClient;
    }

    if (fieldHandlerConf.bufferField) {
      this.bufferField = fieldHandlerConf.bufferField;
    }

    if (fieldHandlerConf.requiredFields) {
      this.requiredFields = fieldHandlerConf.requiredFields;
    }

    // values for Redis hash set
    const hashValues = [];
    hashValues.push(collectionName);
    for (let field in strategyCfg) {
      const strategy = strategyCfg[field].strategy;
      hashValues.push(field);
      hashValues.push(strategy);
      switch (strategy) {
        case Strategies.INCREMENT:
          let startingValue;
          // check if value already exists in redis
          redisClient.get(`${collectionName}:${field}`, (err, reply) => {
            if (err) {
              throw err;
            }
            startingValue = reply;
          });
          if (!startingValue) {
            if (strategyCfg[field].startingValue) {
              startingValue = Number(strategyCfg[field].startingValue) != NaN ?
                strategyCfg[field].startingValue : '0';
            }
            else {
              startingValue = '0';
            }
            redisClient.set(`${collectionName}:${field}`, startingValue, (err, reply) => {
              if (err) {
                throw err;
              }
              if (reply != 'OK') {
                throw Error('Unexpected reply from Redis: ' + reply);
              }
            });
          }
          break;
        default:
          break;
      }
    }
    if (redisClient) {
      redisClient.hset(hashValues, (err, reply) => {
        if (err) {
          throw err;
        }
      });
    }
  }


  /**
   * Finds documents based on provided filters and options
   * @param {object} filter key value filter using mongodb/nedb filter format.
   * @param {number} limit
   * @param {number} offset
   * @param {object} sort key value, key=field value: 1=ASCENDING, -1=DESCENDING, 0=UNSORTED
   * @param {object} field key value, key=field value: 0=exclude, 1=include
   * @returns {an Object that contains an items field}
   */
  async read(filter: Object = {}, limit = 1000, offset = 0,
    sort: any = {}, field: any = {}, customQueries: string[] = [], customArgs: any = {}): Promise<BaseDocument[]> {
    const options = {
      limit: Math.min(limit, 1000),
      offset,
      sort,
      fields: field,
      customQueries,
      customArguments: customArgs.value ? JSON.parse(customArgs.value.toString()) : {}
    };
    const entities: BaseDocument[] = await this.db.find(this.collectionName, filter, options);
    if (this.bufferField) {
      // encode the msg obj back to buffer obj and send it back
      entities.forEach(element => {
        if (element[this.bufferField]) {
          element = encodeMsgObj(element, this.bufferField);
          return element;
        }
      });
    }
    return entities;
  }

  /**
  * Inserts documents to the database.
  *
  * @param {array.object} documents
  */
  async create(documents: BaseDocument[]): Promise<any> {
    const collection = this.collectionName;
    const toInsert = [];
    try {
      for (let i = 0; i < documents.length; i += 1) {
        documents[i] = await setDefaults(documents[i], collection);
        // decode the buffer and store it to DB
        if (this.bufferField) {
          toInsert.push(decodeBufferObj(_.cloneDeep(documents[i]), this.bufferField));
        }
      }
      // check if all the required fields are present
      if (this.requiredFields && this.requiredFields[this.resourceName]) {
        this.checkRequiredFields(this.requiredFields[this.resourceName],
          documents);
      }

      let result = [];
      if (this.isGraphDB(this.db)) {
        await this.db.createGraphDB(this.graphName);
        await this.db.addVertexCollection(collection);
        result = await this.db.createVertex(collection, this.bufferField ? toInsert : documents);
        for (let document of documents) {
          for (let eachEdgeCfg of this.edgeCfg) {
            const fromIDkey = eachEdgeCfg.from;
            const from_id = document[fromIDkey];
            const toIDkey = eachEdgeCfg.to;
            const to_id = document[toIDkey];
            // edges are created outbound, if it is inbound - check for direction
            const direction = eachEdgeCfg.direction;
            let fromVerticeName = collection;
            let toVerticeName = eachEdgeCfg.toVerticeName;
            if (direction === 'inbound') {
              fromVerticeName = eachEdgeCfg.fromVerticeName;
              toVerticeName = collection;
            }
            if (fromVerticeName && toVerticeName) {
              await this.db.addEdgeDefinition(eachEdgeCfg.edgeName, [fromVerticeName],
                [toVerticeName]);
            }
            if (from_id && to_id) {
              if (_.isArray(to_id)) {
                for (let toID of to_id) {
                  await this.db.createEdge(eachEdgeCfg.edgeName, null,
                    `${fromVerticeName}/${from_id}`, `${toVerticeName}/${toID}`);
                }
                continue;
              }
              await this.db.createEdge(eachEdgeCfg.edgeName, null,
                `${fromVerticeName}/${from_id}`, `${toVerticeName}/${to_id}`);
            }
          }
        }
        result.push(result);
        return result;
      }
      else {
        await this.db.insert(collection, this.bufferField ? toInsert : documents);
      }
    } catch (e) {
      if (e.code === 409 || (e.message &&
        e.message.includes('unique constraint violated'))) {
        throw new errors.AlreadyExists('Item Already exists.');
      }
      throw { code: e.code, message: e.message, details: e.details };
    }
  }

  private isGraphDB(db: DatabaseProvider): db is GraphDatabaseProvider {
    return !!this.edgeCfg;
  }

  /**
   * Check if a resource's required fields are present.
   * @param requiredFields
   * @param documents
   */
  checkRequiredFields(requiredFields: string[], documents: any): void {
    for (let document of documents) {
      for (let eachField of requiredFields) {
        const isArray = _.isArray(eachField);
        if (!document[eachField]) {
          throw new errors.InvalidArgument(`Field ${eachField} is necessary
            for ${this.resourceName}`);
        }
        if ((isArray && document[eachField].length == 0)) {
          throw new errors.InvalidArgument(`Field ${eachField} is necessary
            for ${this.resourceName}`);
        }
      }
    }

  }

  /**
   * Removes documents found by id.
   *
   * @param [array.string] ids List of document IDs.
   */
  async delete(ids: string[]): Promise<any> {
    const filter = {
      id: {
        $in: ids
      }
    };

    try {
      if (this.isGraphDB(this.db)) {
        // Modify the Ids to include documentHandle
        if (ids.length > 0) {
          ids = _.map(ids, (id) => {
            return `${this.collectionName}/${id}`;
          });
          return await this.db.removeVertex(this.collectionName, ids);
        }
      }
      await this.db.delete(this.collectionName, filter);
    }
    catch (err) {
      if (err.code === 404 || (err.message &&
        err.message.includes('collection not found'))) {
        throw new errors.NotFound('Collection or one or more items with the given IDs not found.');
      }
    }
  }

  /**
   * Delete all documents in the collection.
   */
  async deleteCollection(): Promise<Array<any>> {
    if (this.isGraphDB(this.db)) {
      // graph edges are only deleted automatically when a specific vertex is deleted
      // (`truncate` does not work in this case)
      const ids = await this.db.find(this.collectionName, {}, {
        fields: {
          id: 1
        }
      });

      await this.delete(_.map(ids, (doc) => {
        return doc.id;
      }));
      return ids;
    } else {
      const entities = await this.db.find(this.collectionName, {}, { fields: { id: 1 } });
      await this.db.truncate(this.collectionName);
      return entities;
    }
  }

  /**
   * Upserts documents.
   *
   * @param [array.object] documents
   */
  async upsert(documents: BaseDocument[],
    events: Topic, resourceName: string): Promise<BaseDocument[]> {
    try {
      const dispatch = []; // CRUD events to be dispatched
      for (let i = 0; i < documents.length; i += 1) {
        let doc = documents[i];
        decodeBufferObj(doc, this.bufferField);

        const foundDocs = await this.db.find(this.collectionName, { id: doc.id }, {
          fields: {
            meta: 1
          }
        });

        let eventName: string;
        if (_.isEmpty(foundDocs)) {
          // insert
          setDefaults(doc, this.collectionName);
          eventName = 'Created';
        } else {
          // update
          const dbDoc = foundDocs[0];
          updateMetadata(dbDoc.meta, doc);
          eventName = 'Modified';
        }

        dispatch.push(events.emit(`${resourceName}${eventName}`, doc));
      }

      const result = await this.db.upsert(this.collectionName, documents);
      await dispatch;

      if (this.bufferField) {
        return _.map(result, doc => encodeMsgObj(doc, this.bufferField));
      }

      return result;
    } catch (error) {
      if (error.code === 404) {
        throw new errors.NotFound('Can\'t find one or more items with the given IDs.');
      }
      throw { code: error.code, message: error.message, details: error.details };
    }
  }

  /**
   * Finds documents by id and updates them.
   *
   * @param [array.object] documents
   * A list of documents or partial documents. Each document must contain an id field.
   */
  async update(documents: BaseDocument[]): Promise<BaseDocument[]> {
    try {
      const collectionName = this.collectionName;
      let patches = [];
      for (let i = 0; i < documents.length; i += 1) {
        let doc = documents[i];
        if (this.bufferField) {
          doc = decodeBufferObj(_.cloneDeep(documents[i]), this.bufferField);
        }

        const foundDocs = await this.db.find(collectionName, { id: doc.id },
          {
            fields: {
              meta: 1
            }
          });
        if (_.isEmpty(foundDocs)) {
          throw { code: 404 };
        }
        const dbDoc = foundDocs[0];
        doc = updateMetadata(dbDoc.meta, doc);

        if (this.isGraphDB(this.db)) {
          const db = this.db;

          for (let eachEdgeCfg of this.edgeCfg) {
            const toIDkey = eachEdgeCfg.to;
            let modified_to_idValues = doc[toIDkey];
            let db_to_idValues = dbDoc[toIDkey];
            if (_.isArray(modified_to_idValues)) {
              modified_to_idValues = _.sortBy(modified_to_idValues);
            }
            if (_.isArray(db_to_idValues)) {
              db_to_idValues = _.sortBy(db_to_idValues);
            }
            // delete and recreate only if there is a difference in references
            if (!_.isEqual(modified_to_idValues, db_to_idValues)) {
              // TODO delete and recreate the edge (since there is no way to update the edge as we dont add id to the edge as for doc)
              const fromIDkey = eachEdgeCfg.from;
              const from_id = doc[fromIDkey];
              let fromVerticeName = collectionName;
              let toVerticeName = eachEdgeCfg.toVerticeName;
              const direction = eachEdgeCfg.direction;
              if (direction === 'inbound') {
                fromVerticeName = eachEdgeCfg.fromVerticeName;
                toVerticeName = collectionName;
              }

              const edgeCollectionName = eachEdgeCfg.edgeName;
              let outgoingEdges: any = await db.getOutEdges(edgeCollectionName, `${collectionName}/${dbDoc.id}`);
              for (let outgoingEdge of outgoingEdges) {
                await db.removeEdge(edgeCollectionName, outgoingEdge._id);
              }
              let incomingEdges: any = await db.getInEdges(edgeCollectionName, `${collectionName}/${dbDoc.id}`);
              for (let incomingEdge of incomingEdges) {
                await db.removeEdge(edgeCollectionName, incomingEdge._id);
              }
              // Create new edges
              if (from_id && modified_to_idValues) {
                if (_.isArray(modified_to_idValues)) {
                  for (let toID of modified_to_idValues) {
                    await db.createEdge(eachEdgeCfg.edgeName, null,
                      `${fromVerticeName}/${from_id}`, `${toVerticeName}/${toID}`);
                  }
                  continue;
                }
                await db.createEdge(edgeCollectionName, null,
                  `${fromVerticeName}/${from_id}`, `${toVerticeName}/${modified_to_idValues}`);
              }
            }
          }
        }

        patches.push(await this.db.update(collectionName,
          { id: doc.id }, _.omitBy(doc, _.isNil)));
      }

      patches = _.flatten(patches);
      if (this.bufferField) {
        patches = _.map(patches, patch => encodeMsgObj(patch, this.bufferField));
      }
      return patches;
    } catch (e) {
      if (e.code === 404) {
        throw new errors.NotFound('Can\'t find one or more items with the given IDs.');
      }
      throw { code: e.code, message: e.message, details: e.details };
    }
  }
}
