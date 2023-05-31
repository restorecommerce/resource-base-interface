import * as _ from 'lodash';
import { errors } from '@restorecommerce/chassis-srv';
import * as uuid from 'uuid';
import { Topic } from '@restorecommerce/kafka-client';
import { BaseDocument, DocumentMetadata } from './interfaces';
import { DatabaseProvider, GraphDatabaseProvider } from '@restorecommerce/chassis-srv';

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

const setDefaults = async (obj: { meta?: DocumentMetadata;[key: string]: any }, collectionName: string): Promise<any> => {
  const o = obj;

  if (_.isEmpty(o.meta)) {
    throw new errors.InvalidArgument('Object does not contain ownership information');
  }

  const now = Date.now();
  if (redisClient) {
    const values = await redisClient.hGetAll(collectionName);

    if (values) {
      for (let field in values) {
        const strategy = values[field];
        switch (strategy) {
          case Strategies.INCREMENT:
            const key = collectionName + ':' + field;
            o[field] = await redisClient.get(key);
            await redisClient.incr(key);
            break;
          case Strategies.UUID:
            o[field] = uuidGen();
            break;
          case Strategies.RANDOM:
            o[field] = uuidGen();
            break;
          case Strategies.TIMESTAMP:
            o[field] = await redisClient.time()[0];
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

  if (!_.isEmpty(newDoc.meta.owners)) {
    // if ownership is meant to be updated
    docMeta.owners = newDoc.meta.owners;
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
  dateTimeField: string[];
  resourceName: string;
  logger: any;
  /**
   * @constructor
   * @param  {object} db Chassis arangodb provider.
   * @param {string} collectionName Name of database collection.
   * @param {any} fieldHandlerConf The collection's field generators configuration.
   */
  constructor(private db: DatabaseProvider, private collectionName: string, fieldHandlerConf?: any,
    private edgeCfg?: any, private graphName?: string, logger?: any) {
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

    // config fix to be removed after ts-proto is used
    if (fieldHandlerConf.dateTimeField) {
      this.dateTimeField = fieldHandlerConf.dateTimeField;
    }

    if (fieldHandlerConf.requiredFields) {
      this.requiredFields = fieldHandlerConf.requiredFields;
    }

    // values for Redis hash set
    for (let field in strategyCfg) {
      const strategy = strategyCfg[field].strategy;
      redisClient.hSet(collectionName, field, strategy);
      switch (strategy) {
        case Strategies.INCREMENT:
          // check if value already exists in redis
          let startingValue: any;
          startingValue = redisClient.get(`${collectionName}:${field}`).then((val) => val);
          if (!startingValue) {
            if (strategyCfg[field].startingValue) {
              startingValue = Number.isNaN(strategyCfg[field].startingValue) ?
                '0' : strategyCfg[field].startingValue;
            }
            else {
              startingValue = '0';
            }
            redisClient.set(`${collectionName}:${field}`, startingValue).then((val) => val);
          }
          break;
        default:
          break;
      }
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
    let entities: BaseDocument[] = await this.db.find(this.collectionName, filter, options);
    if (this.bufferField) {
      // encode the msg obj back to buffer obj and send it back
      entities.forEach(element => {
        if (element[this.bufferField]) {
          element = encodeMsgObj(element, this.bufferField);
          return element;
        }
      });
    }
    // config fix to be removed after ts-proto is used
    entities = this.convertmsToSecondsNanos(entities);
    return entities;
  }

  /**
  * Inserts documents to the database.
  *
  * @param {array.object} documents
  */
  async create(documents: BaseDocument[]): Promise<any> {
    const collection = this.collectionName;
    let toInsert = [];
    let result = [];
    try {
      let result = [];
      // check if all the required fields are present
      if (this.requiredFields && this.requiredFields[this.resourceName]) {
        const requiredFieldsResult = this.checkRequiredFields(this.requiredFields[this.resourceName],
          documents, result);
        documents = requiredFieldsResult.documents;
        result = requiredFieldsResult.result;
      }

      toInsert = await Promise.all(documents.map(async (doc) => {
        doc = await setDefaults(doc, collection);
        // decode the buffer and store it to DB
        if (this.bufferField) {
          return (decodeBufferObj(_.cloneDeep(doc), this.bufferField));
        } else {
          return doc;
        }
      }));

      // config fix to be removed after ts-proto is used
      documents = this.convertSecondsNanosToms(documents);
      if (this.isGraphDB(this.db)) {
        await this.db.createGraphDB(this.graphName);
        await this.db.addVertexCollection(collection);
        let createVertexResp = await this.db.createVertex(collection, this.bufferField ? toInsert : documents);
        for (let document of documents) {
          if (this.edgeCfg && _.isArray(this.edgeCfg) && this.edgeCfg.length > 0) {
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
              if (from_id && to_id) {
                if (_.isArray(to_id)) {
                  for (let toID of to_id) {
                    await this.db.createEdge(eachEdgeCfg.edgeName, null,
                      `${fromVerticeName}/${from_id}`, `${toVerticeName}/${toID}`);
                  }
                } else {
                  await this.db.createEdge(eachEdgeCfg.edgeName, null,
                    `${fromVerticeName}/${from_id}`, `${toVerticeName}/${to_id}`);
                }
              }
            }
          }
        }
        if (_.isArray(createVertexResp)) {
          createVertexResp.forEach((eachVertexResp) => result.push(eachVertexResp));
        } else {
          result.push(createVertexResp);
        }
        // config fix to be removed after ts-proto is used
        result = this.convertmsToSecondsNanos(result);
        return result;
      }
      else {
        let checkReqFieldResult = [];
        if (!_.isEmpty(result)) {
          checkReqFieldResult = result;
        }
        result = await this.db.insert(collection, this.bufferField ? toInsert : documents);
        if (!_.isEmpty(checkReqFieldResult)) {
          checkReqFieldResult.forEach((reqFieldResult) => result.push(reqFieldResult));
        }
        // config fix to be removed after ts-proto is used
        result = this.convertmsToSecondsNanos(result);
        return result;
      }
    } catch (e) {
      this.logger.error('Error creating documents', { code: e.code, message: e.message, stack: e.stack });
      result.push({
        error: true,
        errorNum: e.code,
        errorMessage: e.details ? e.details : e.message
      });
      return result;
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
  checkRequiredFields(requiredFields: string[], documents: any, result: any[]): any {
    documents.forEach((document) => {
      requiredFields.forEach((eachField) => {
        const isArray = _.isArray(eachField);
        if (!document[eachField]) {
          result.push({
            error: true,
            errorNum: 400,
            errorMessage: `Field ${eachField} is necessary for ${this.resourceName} for documentID ${document.id}`
          });
          documents = documents.filter(doc => doc.id != document.id);
        }
        if ((isArray && document[eachField].length == 0)) {
          result.push({
            error: true,
            errorNum: 400,
            errorMessage: `Field ${eachField} is necessary for ${this.resourceName} for documentID ${document.id}`
          });
          documents = documents.filter(doc => doc.id != document.id);
        }
      });
    });
    return { documents, result };
  }

  /**
   * Removes documents found by id.
   *
   * @param [array.string] ids List of document IDs.
   */
  async delete(ids: string[]): Promise<any> {
    let deleteResponse = [];
    try {
      if (!_.isArray(ids)) {
        ids = [ids];
      }
      if (this.isGraphDB(this.db)) {
        // Modify the Ids to include documentHandle
        if (ids.length > 0) {
          ids = _.map(ids, (id) => {
            return `${this.collectionName}/${id}`;
          });
          deleteResponse = await this.db.removeVertex(this.collectionName, ids);
          return deleteResponse;
        }
      }
      deleteResponse = await this.db.delete(this.collectionName, ids);
      return deleteResponse;
    }
    catch (err) {
      this.logger.error('Error deleting documents', { code: err.code, message: err.message, stack: err.stack });
      deleteResponse.push({
        error: true,
        errorNum: err.code,
        errorMessage: err.details ? err.details : err.message
      });
      return deleteResponse;
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
    let result = [];
    let createDocsResult = [];
    let updateDocsResult = [];
    try {
      let createDocuments = [];
      let updateDocuments = [];
      let dispatch = [];
      dispatch = await Promise.all(documents.map(async (doc) => {
        decodeBufferObj(doc, this.bufferField);
        let foundDocs;
        if (doc && doc.id) {
          foundDocs = await this.db.find(this.collectionName, { id: doc.id }, {
            fields: {
              meta: 1
            }
          });
        }
        let eventName: string;
        if (_.isEmpty(foundDocs)) {
          // insert
          setDefaults(doc, this.collectionName);
          createDocuments.push(doc);
          eventName = 'Created';
        } else {
          // update
          const dbDoc = foundDocs[0];
          updateMetadata(dbDoc.meta, doc);
          updateDocuments.push(doc);
          eventName = 'Modified';
        }
        if (events) {
          return events.emit(`${resourceName}${eventName}`, doc);
        }
      }));

      if (createDocuments.length > 0) {
        createDocuments = this.convertSecondsNanosToms(createDocuments);
        createDocsResult = await this.create(createDocuments);
      }

      if (updateDocuments.length > 0) {
        updateDocuments = this.convertSecondsNanosToms(updateDocuments);
        updateDocsResult = await this.update(updateDocuments);
      }

      result = _.union(createDocuments, updateDocuments);
      // config fix to be removed after ts-proto is used
      result = this.convertmsToSecondsNanos(result);
      await Promise.all(dispatch);

      if (this.bufferField) {
        return _.map(result, doc => encodeMsgObj(doc, this.bufferField));
      }

      return result;
    } catch (error) {
      this.logger.error('Error upserting documents', { code: error.code, message: error.message, stack: error.stack });
      result.push({
        error: true,
        errorNum: error.code,
        errorMessage: error.details ? error.details : error.message
      });
      return result;
    }
  }

  /**
   * Finds documents by id and updates them.
   *
   * @param [array.object] documents
   * A list of documents or partial documents. Each document must contain an id field.
   */
  async update(documents: BaseDocument[]): Promise<BaseDocument[]> {
    let updateResponse = [];
    try {
      const collectionName = this.collectionName;
      let docsWithUpMetadata = await Promise.all(documents.map(async (doc) => {
        if (this.bufferField) {
          doc = decodeBufferObj(_.cloneDeep(doc), this.bufferField);
        }
        const foundDocs = await this.db.find(collectionName, { id: doc.id });
        let dbDoc;
        if (foundDocs && foundDocs.length === 1) {
          dbDoc = foundDocs[0];
          doc = updateMetadata(dbDoc.meta, doc);
        } else {
          dbDoc = doc; // doc not existing assigning to generate error message in response
        }

        if (this.isGraphDB(this.db)) {
          const db = this.db;
          await Promise.all(this.edgeCfg.map(async (eachEdgeCfg) => {
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
              // delete and recreate the edge (since there is no way to update the edge as we dont add id to the edge as for doc)
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
              if (_.isArray(outgoingEdges.edges)) {
                await Promise.all(outgoingEdges.edges.map((outgoingEdge) => db.removeEdge(edgeCollectionName, outgoingEdge._id)));
              }
              let incomingEdges: any = await db.getInEdges(edgeCollectionName, `${collectionName}/${dbDoc.id}`);
              if (_.isArray(incomingEdges.edges)) {
                await Promise.all(incomingEdges.edges.map((incomingEdge) => db.removeEdge(edgeCollectionName, incomingEdge._id)));
              }
              // Create new edges
              if (from_id && modified_to_idValues) {
                if (_.isArray(modified_to_idValues)) {
                  await Promise.all(modified_to_idValues.map((toID) => db.createEdge(eachEdgeCfg.edgeName, null,
                    `${fromVerticeName}/${from_id}`, `${toVerticeName}/${toID}`)));
                } else {
                  await db.createEdge(edgeCollectionName, null,
                    `${fromVerticeName}/${from_id}`, `${toVerticeName}/${modified_to_idValues}`);
                }
              }
            }
          }));
        }
        return doc;
      }));

      // config fix to be removed after ts-proto is used
      docsWithUpMetadata = this.convertSecondsNanosToms(docsWithUpMetadata);
      updateResponse = await this.db.update(collectionName, docsWithUpMetadata);
      updateResponse = this.convertmsToSecondsNanos(updateResponse);
      if (this.bufferField) {
        updateResponse = _.map(updateResponse, patch => encodeMsgObj(patch, this.bufferField));
      }
      return updateResponse;
    } catch (e) {
      this.logger.error('Error updating documents', { code: e.code, message: e.message, stack: e.stack });
      updateResponse.push({
        error: true,
        errorNum: e.code,
        errorMessage: e.message
      });
      return updateResponse;
    }
  }

  private convertSecondsNanosToms(documents: any): any {
    documents?.forEach(doc => {
      this.dateTimeField?.forEach((field) => {
        if (field.indexOf('.')) {
          this.updateJSON(field, doc, true);
        } else if (field && doc[field]?.seconds) {
          // convert seconds and nano seconds to unix epoch date time in mili seconds
          let millis = doc[field].seconds * 1_000;
          millis += doc[field]?.nanos / 1_000_000;
          doc[field] = millis;
        }
      });
    });
    return documents;
  }

  private convertmsToSecondsNanos(documents: any): any {
    documents?.forEach(doc => {
      this.dateTimeField?.forEach(field => {
        if (field.indexOf('.')) {
          this.updateJSON(field, doc, false);
        } else if (doc && doc[field]) {
          const seconds = doc[field] / 1_000;
          const nanos = (doc[field] % 1_000) * 1_000_000;
          doc[field] = { seconds, nanos };
        }
      });
    });
    return documents;
  }

  private updateJSON = (path, obj, secondsNanoToms = true) => {
    let fields = path.split('.');
    let result = obj;
    let j = 0;
    for (let i = 0, n = fields.length; i < n && result !== undefined; i++) {
      let field = fields[i];
      if (i === n - 1) {
        // reset value finally after iterating to the position (only if value already exists)
        if (result[field]) {
          if (secondsNanoToms && result[field]?.seconds) {
            let millis = result[field].seconds * 1_000;
            millis += result[field]?.nanos / 1_000_000;
            result[field] = millis;
          } else {
            const seconds = result[field] / 1_000;
            const nanos = (result[field] % 1_000) * 1_000_000;
            result[field] = { seconds, nanos };
          }
        }
      } else {
        if (_.isArray(result[field])) {
          // till i < n concat new fields
          let newField;
          for (let k = i + 1; k < n; k++) {
            if (newField) {
              newField = newField + '.' + fields[k];
            } else {
              newField = fields[k];
            }
          }
          for (; j < result[field].length; j++) {
            // recurisve call to update each element if its an array
            this.updateJSON(newField, result[field][j], secondsNanoToms);
          }
        } else {
          // update object till final path is reached
          result = result[field];
        }
      }
    }
  };
}
