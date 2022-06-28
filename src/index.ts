import * as _ from 'lodash';

const filterOperationMap = new Map([
  [0, 'eq'],
  [1, 'lt'],
  [2, 'lte'],
  [3, 'gt'],
  [4, 'gte'],
  [5, 'isEmpty'],
  [6, 'iLike'],
  [7, 'in'],
  [8, 'neq']
]);

const filterOperatorMap = new Map([
  [0, 'and'],
  [1, 'or']
]);

const insertFilterFieldOpValue = (filter, object, key) => {
  let value;
  if (!filter.type || filter.type === 'STRING' || filter.type === 0) {
    value = filter.value;
  } else if ((filter.type === 'NUMBER' || filter.type === 1) && !isNaN(filter.value)) {
    value = Number(filter.value);
  } else if (filter.type === 'BOOLEAN' || filter.type === 2) {
    if (filter.value === 'true') {
      value = true;
    } else if (filter.value === 'false') {
      value = false;
    }
  } else if (filter.type === 'ARRAY' || filter.type === 4) {
    try {
      value = JSON.parse(filter.value);
    } catch (err) {
      // to handle JSON string parse error
      if (err.message.indexOf('Unexpected token') > -1) {
        value = JSON.parse(JSON.stringify(filter.value));
      } else {
        throw err;
      }
    }
  } else if (filter.type === 'DATE' || filter.type === 3) {
    value = (new Date(filter.value)).getTime();
  }

  let temp;
  if (key) {
    temp = object[key];
  } else {
    // should be root level filter, if key does not exist
    object = [];
    temp = object;
  }
  if (filter.operation === 'eq' || filter.operation === 0) {
    if (_.isArray(temp)) {
      temp.push({ [filter.field]: value });
    } else {
      temp.push({ [filter.field]: value });
    }
  } else if (filter.operation === 'neq' || filter.operation === 8) {
    if (_.isArray(temp)) {
      temp.push({ [filter.field]: { $not: { $eq: value } } });
    } else {
      temp.push({ [filter.field]: { $not: { $eq: value } } });
    }
  } else {
    let op, opValue;
    if (typeof filter.operation === 'string' || filter.operation instanceof String) {
      opValue = filter.operation;
    } else if (Number.isInteger(filter.operation)) {
      opValue = filterOperationMap.get(filter.operation);
    }
    op = `$${opValue}`;
    if (_.isArray(temp)) {
      temp.push({ [filter.field]: { [op]: value } });
    } else {
      temp.push({ [filter.field]: { [op]: value } });
    }
  }
  return object;
};

/**
 * Takes filter object containing field, operation and value and updates the filter in
 * object with operator style understandable by chassis-srv for later to be used for
 * AQL conversion
 * @param object converted filter object
 * @param originalKey operator value
 * @param filter object containing field, operation, value and type
 * @returns object
 */
const convertFilterToObject = (object, operatorKey, filter) => {
  if (object !== null) {
    if (Array.isArray(object)) {
      for (const arrayItem of object) {
        convertFilterToObject(arrayItem, operatorKey, filter);
      }
    } else if (typeof object === 'object') {
      for (const key of Object.keys(object)) {
        // Match found, update object with filter field, operation and value into object
        if (key === operatorKey) {
          object = insertFilterFieldOpValue(filter, object, operatorKey);
        } else {
          convertFilterToObject(object[key], operatorKey, filter);
        }
      }
    }
  }
  if (!operatorKey) {
    // should be root level filter
    object = insertFilterFieldOpValue(filter, object, operatorKey);
    object = object[0];
  }
  return object;
};

/**
 * finds the nested object key position
 * @param entireObj Object in which the postion for key is to be found
 * @param keyToFind key to be found in Object
 * @returns value of the object at found key
 */
const findNestedObj = (entireObj, keyToFind) => {
  let keys = Object.keys(entireObj);
  if (keys && keys.length > 0) {
    for (let key of keys) {
      if (key === keyToFind) {
        return entireObj[key];
      } else if (Object.keys(entireObj[key])) {
        if (_.isArray(Object.keys(entireObj))) {
          findNestedObj(entireObj[key], keyToFind);
        }
      }
    }
  }
};

/**
 * convertToObject takes input contained in the proto structure defined in resource_base proto
 * and converts it into Object understandable by the underlying DB implementation in chassis-srv
 * @param {*} input Original filter input object
 * @param {*} obj converted filter objected passed recursively
 * @param {*} currentOperator current operatro value passed recursively
 */
export const convertToObject = (input: any, obj?: any, currentOperator?: string) => {
  // since toObject method is called recursively we are not adding the typing to input parameter
  let filters;
  if (input && !_.isEmpty(input.filters)) {
    filters = input.filters;
  } else {
    filters = input;
  }
  // by default use 'and' operator if no operator is specified
  if (filters && _.isArray(filters.filter) && !filters.operator) {
    filters.operator = 'and';
  }
  if (!obj) {
    obj = {};
  }
  if (_.isArray(filters.filter)) {
    let operatorValue;
    if (typeof filters.operator === 'string' || filters.operator instanceof String) {
      operatorValue = filters.operator;
    } else if (Number.isInteger(filters.operator)) {
      operatorValue = filterOperatorMap.get(filters.operator);
    }
    const newOperator = `$${operatorValue}`;
    if (newOperator && !currentOperator) {
      // insert obj with new operator
      Object.assign(obj, { [newOperator]: [] });
    } else if (newOperator && currentOperator) {
      // find the currentOperator and add newOperator under currentOperator of Obj
      let t = findNestedObj(obj, currentOperator);
      if (_.isArray(t)) {
        t.push({ [newOperator]: [] });
      } else {
        Object.assign(t, { [newOperator]: [] });
      }
    } else {
      obj[newOperator] = [];
    }
    // pass newOperator and obj recursively
    convertToObject(filters.filter, obj, newOperator);
  } else if (_.isArray(filters)) {
    for (let filterObj of filters) {
      convertToObject(filterObj, obj, currentOperator);
    }
  } else if (filters.field && (filters.operation || filters.operation === 0) && filters.value != undefined) {
    // object contains field, operation and value, update it on obj using convertFilterToObject()
    obj = convertFilterToObject(obj, currentOperator, filters);
  }
  return obj;
};

/**
 * converts input filters to json object understandable by chassis-srv for AQL conversion
 * @param input input filters object
 * @returns json object understandable by chassiss-rv for AQL conversion
 */
export const toObject = (input) => {
  let filtersArr = input.filters;
  if (!filtersArr) {
    filtersArr = input;
  }
  let finalObj = {};
  let convertedObject = [];
  if (_.isArray(filtersArr)) {
    for (let filterArr of filtersArr) {
      let t = filterArr?.filter;
      let operatorValue;
      if (typeof filterArr?.operator === 'string' || filterArr?.operator instanceof String) {
        operatorValue = filterArr?.operator;
      } else if (Number.isInteger(filterArr?.operator)) {
        operatorValue = filterOperatorMap.get(filterArr?.operator);
      }
      // default operator is `and`
      if (!operatorValue) {
        operatorValue = 'and';
      }
      for (let filter of t) {
        let obj = {};
        obj = convertToObject(filter, obj);
        if(!_.isEmpty(obj)) {
          convertedObject.push(obj);
        }
      }
      if (!_.isEmpty(convertedObject)) {
        finalObj[`$${operatorValue}`] = convertedObject;
      }
    }
  }
  return finalObj;
};

import { ResourcesAPIBase } from './core/ResourcesAPI';
export { ResourcesAPIBase };
import { ServiceBase } from './core/ServiceBase';
export { ServiceBase };
import { GraphResourcesServiceBase } from './core/GraphResourcesServiceBase';
export { GraphResourcesServiceBase };
export { Filter, FilterOp, FilterOperation, FilterValueType, OperatorType, TraversalOptions, GraphFilters, GraphFilter } from './core/interfaces';