import { type CallContext } from 'nice-grpc-common';
import {
  GraphDatabaseProvider,
  TraversalResponse as DBTraversalResponse
} from '@restorecommerce/chassis-srv';
import { Logger } from '@restorecommerce/logger';
import {
  OperationStatus
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/status';
import {
  DeepPartial, ServerStreamingMethodResult,
  GraphServiceImplementation,
  TraversalRequest,
  TraversalResponse
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/graph';
import { SortOrder } from './interfaces';

/**
 * Graph Resource API base provides functions for graph Operations such as
 * creating or modifying Vertices/Edges, graph traversal etc.
 */
export class GraphResourcesServiceBase implements GraphServiceImplementation {
  bufferedCollections: any;
  /**
   * @constructor
   * @param  {object} db Chassis arangodb provider.
   */
  constructor(
    private readonly db: GraphDatabaseProvider,
    private readonly bufferFiledCfg?: any,
    private readonly logger?: Logger,
    private readonly dateTimeFieldcfg?: any
  ) {
    if (bufferFiledCfg) {
      this.bufferedCollections = [];
      for (const key in bufferFiledCfg) {
        // mapping of collection name to the property to be marshalled
        this.bufferedCollections.push(key);
      }
    }
    this.dateTimeFieldcfg = dateTimeFieldcfg;
  }

  protected catchOperationError(msg: string, err: any): OperationStatus {
    this.logger?.error(msg, err);
    return {
      code: Number.isInteger(err.code) ? err.code : 500,
      message: err.message ?? 'Unknown Error!',
    };
  }

  /**
  * collection traversal - Performs a traversal starting from the given
  * startVertex and following edges contained in this edge collection.
  *
  * The start_vertex can be either the _id of a document in the database,
  * the _key of an edge in the collection, or a document
  * (i.e. an object with an _id or _key property).
  * opts contains the options such as opts.direction, opts.filter, opts.visitor,
  * opts.init, opts.expander, opts.sort
  */
  async* traversal(
    request: TraversalRequest,
    context: CallContext
  ): ServerStreamingMethodResult<DeepPartial<TraversalResponse>> {
    try {
      const vertices = request?.vertices;
      const collection = request?.collection;
      const options = request?.opts;
      if (!vertices && !collection) {
        const message = 'missing start vertex or collection_name for graph traversal';
        this.logger?.error(message);
        yield {
          operation_status: { code: 400, message }
        };
        return;
      }
      const filters = request?.filters;
      const path = request?.path ? request.path : false;
      let traversalCursor: DBTraversalResponse;

      if (collection?.sorts?.length) {
        (collection as any).sorts = collection.sorts.reduce((a, s) => {
          switch (s.order) {
            case SortOrder.ASCENDING:
              a[s.field] = 'ASC';
              break;
            case SortOrder.DESCENDING:
              a[s.field] = 'DESC';
              break;
            case SortOrder.UNSORTED:
            default:
              break;
          }
          return a;
        }, {} as Record<string, string>);
      }

      try {
        this.logger?.debug('Calling traversal', { vertices, collection });
        traversalCursor = await this.db.traversal(
          vertices, collection,
          options, filters
        );
        this.logger?.debug('Received traversal ArrayCursor from DB');
      } catch (err: any) {
        yield {
          operation_status: this.catchOperationError('Error executing DB Traversal', err)
        };
        return;
      }

      const rootCursor = traversalCursor.rootCursor;
      const associationCursor = traversalCursor.associationCursor;
      // root entity data batches
      if (rootCursor && rootCursor.batches) {
        for await (const batch of rootCursor.batches) {
          // root entity data, encoding before pushing batch
          for (const elem of batch) {
            if (elem._key) {
              delete elem._key;
            }
            if (elem._rev) {
              delete elem._rev;
            }
          }
          yield ({ data: { value: Buffer.from(JSON.stringify(batch)) } });
        }
      }
      // association entity data batches
      if (associationCursor && associationCursor.batches) {
        for await (const batch of associationCursor.batches) {
          const associationData = [];
          const traversedPaths = [];
          for (const data of batch) {
            if (data.v._key) {
              delete data.v._key;
            }
            if (data.v._rev) {
              delete data.v._rev;
            }
            // convert `data.v` ie. vertex data for time fields conversion from ms to ISO string directly
            const entityName = data.v._id.split('/')[0];
            if (this.dateTimeFieldcfg) {
              for (const cfgEntityNames in this.dateTimeFieldcfg) {
                if(cfgEntityNames === entityName) {
                  const dateTimeFields: string[] = this.dateTimeFieldcfg[entityName];
                  dateTimeFields.forEach(e => {
                    if (e.includes('.')) {
                      this.updateJSON(e, data.v);
                    } else {
                      data.v[e] = new Date(data.v[e]).toISOString();
                    }
                  });
                }
              }
            }
            associationData.push(data.v);
            if (path) {
              traversedPaths.push(data.p);
            }
          }

          if (associationData.length) {
            // associated entity data, encoding before pushing data
            yield ({ data: { value: Buffer.from(JSON.stringify(associationData)) } });
          }
          // paths
          if (traversedPaths.length) {
            // traversed paths, encoding before pushing paths
            yield ({ paths: { value: Buffer.from(JSON.stringify(traversedPaths)) } });
          }
        }
      }

      yield ({ operation_status: { code: 200, message: 'success' } });
      this.logger?.debug('Traversal request ended');
      return;
    } catch (err: any) {
      yield {
        operation_status: this.catchOperationError('Error caught executing traversal', err)
      };
      return;
    }
  }

  /**
   * marshall the data
   *
   * @param document resource data
   * @param bufferField property specified in config to be marshalled
   * @return document
   */
  marshallData(document: any, bufferField: any): any {
    if (bufferField in document && document[bufferField]) {
      const decodedMsg = document[bufferField];
      // convert the Msg obj to Buffer Obj
      const encodedBufferObj = Buffer.from(JSON.stringify(decodedMsg));
      document[bufferField] = {};
      document[bufferField].value = encodedBufferObj;
    }
    return document;
  }

  private updateJSON = (path: string, obj: any) => {
    const fields = path.split('.');
    let result = obj;
    let j = 0;
    for (let i = 0, n = fields.length; i < n && result !== undefined; i++) {
      const field = fields[i];
      if (i === n - 1) {
        // reset value finally after iterating to the position (only if value already exists)
        if (result[field]) {
          result[field] = new Date(result[field]).toISOString();
        }
      } else {
        if (Array.isArray(result[field])) {
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
            this.updateJSON(newField, result[field][j]);
          }
        } else {
          // update object till final path is reached
          result = result[field];
        }
      }
    }
  };
}
