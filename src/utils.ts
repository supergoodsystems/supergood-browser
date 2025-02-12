import {
  HeaderOptionType,
  InfoPayloadType,
  RequestType,
  ResponseType,
  EventRequestType,
  ErrorPayloadType,
  RemoteConfigPayloadType,
  RemoteConfigType,
  EndpointConfigType,
  SensitiveKeyMetadata,
  TelemetryType
} from './types';
import { postError } from './api';
import { name, version } from '../package.json';
import { errors } from './constants';
import _set from 'lodash.set';
import _get from 'lodash.get';

const logger = ({
  errorSinkUrl,
  headerOptions,
  logLevel,
}: {
  errorSinkUrl?: string;
  headerOptions: HeaderOptionType;
  logLevel?: string;
}) => {
  const packageName = name;
  const packageVersion = version;
  return {
    error: (
      message: string,
      payload: InfoPayloadType,
      error: Error,
      { reportOut }: { reportOut: boolean } = { reportOut: true }
    ) => {
      if (logLevel === 'debug') {
        console.error(
          new Date().toISOString(),
          `${packageName}@${packageVersion}: ${message}`,
          JSON.stringify(payload, null, 2),
          error
        );
      }
      if (reportOut && errorSinkUrl) {
        postError(
          errorSinkUrl,
          {
            payload: { ...payload, packageName, packageVersion },
            error: JSON.stringify(error, Object.getOwnPropertyNames(error)),
            message
          },
          headerOptions
        );
      }
    },
    info: (message: string, payload?: InfoPayloadType) => {
      console.log(
        new Date().toISOString(),
        `${packageName}@${packageVersion}: ${message}`,
        payload ?? JSON.stringify(payload, null, 2)
      );
    },
    debug: (message: string, payload?: any) => {
      if (logLevel === 'debug') {
        console.log(
          new Date().toISOString(),
          `${packageName}@${packageVersion}: ${message}`,
          payload ?? JSON.stringify(payload, null, 2)
        );
      }
    }
  };
};

const getHeaderOptions = (
  clientId: string,
): HeaderOptionType => {
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(
        clientId
      ).toString('base64')}`,
      'Supergood-api': 'supergood-browser',

    }
  };
};

const marshalKeyPath = (keypath: string) => {
  if (/^requestHeaders/.test(keypath)) return keypath.replace('requestHeaders', 'request.headers');
  if (/^requestBody/.test(keypath)) return keypath.replace('requestBody', 'request.body');
  if (/^responseHeaders/.test(keypath)) return keypath.replace('responseHeaders', 'response.headers');
  if (/^responseBody/.test(keypath)) return keypath.replace('responseBody', 'response.body');
  return keypath;
}

const unmarshalKeyPath = (keypath: string) => {
  if (/^request\.headers/.test(keypath)) return keypath.replace('request.headers', 'requestHeaders');
  if (/^request\.body/.test(keypath)) return keypath.replace('request.body', 'requestBody');
  if (/^response\.headers/.test(keypath)) return keypath.replace('response.headers', 'responseHeaders');
  if (/^response\.body/.test(keypath)) return keypath.replace('response.body', 'responseBody');
  return keypath;
}

const expandSensitiveKeySetForArrays = (obj: any, sensitiveKeys: Array<string>): Array<string> => {
  const expandKey = (key: string, obj: any): Array<string> => {
    // Split the key by dots, considering the array brackets as part of the key
    const parts = key.match(/[^.\[\]]+|\[\d*\]|\[\*\]/g) || [];

    // Recursively expand the key
    return expand(parts, obj, '');
  };

  const expand = (parts: string[], obj: any, keyPath: string): Array<string> => {
    const path = keyPath;
    if (parts.length === 0) {
      return [path]; // Remove trailing dot
    }
    const part = parts[0];
    const isProperty = !part.startsWith('[');
    const separator = path && isProperty ? '.' : '';

    // Check for array notations
    if (/\[\*?\]/.test(part)) {
      if (!Array.isArray(obj)) {
        return [];
      }
      // Expand for each element in the array
      return obj.flatMap((_, index) =>
        expand(parts.slice(1), obj[index], `${path}${separator}[${index}]`)
      );
    } else if (part.startsWith('[') && part.endsWith(']')) {
      // Specific index in the array
      const index = parseInt(part.slice(1, -1), 10);
      if (!isNaN(index) && index < obj.length) {
        return expand(parts.slice(1), obj[index], `${path}${separator}${part}`);
      } else {
        return [];
      }
    } else {
      // Regular object property
      if (obj && typeof obj === 'object' && part in obj) {
        return expand(parts.slice(1), obj[part], `${path}${separator}${part}`);
      } else {
        return [];
      }
    }
  };

  return sensitiveKeys.flatMap(key => expandKey(key, obj));
};

const redactValuesFromKeys = (
  event: { request?: RequestType; response?: ResponseType },
  remoteConfig: RemoteConfigType
): { event: { request?: RequestType; response?: ResponseType }, sensitiveKeyMetadata: Array<SensitiveKeyMetadata> } => {
  let sensitiveKeyMetadata: Array<SensitiveKeyMetadata> = [];
  const endpointConfig = getEndpointConfigForRequest(event.request as RequestType, remoteConfig);
  if (!endpointConfig || !endpointConfig?.sensitiveKeys?.length) return { event, sensitiveKeyMetadata };
  else {
    const sensitiveKeys = expandSensitiveKeySetForArrays(event, endpointConfig.sensitiveKeys.map(key => marshalKeyPath(key)))
    for (let i = 0; i < sensitiveKeys.length; i++) {
      const keyPath = sensitiveKeys[i];
      // Add sensitive key for array expansion
      const value = _get(event, keyPath);
      if (value) {
        _set(event, keyPath, null);
        // Don't return <string-length>:<string-type> for null values
        sensitiveKeyMetadata.push({ keyPath: unmarshalKeyPath(keyPath), ...redactValue(value) });
      }
    }
    return { event, sensitiveKeyMetadata };
  }
};

const safeParseJson = (json: string) => {
  try {
    return JSON.parse(json);
  } catch (e) {
    return json;
  }
};

const redactValue = (
  input: string | Record<string, string> | [Record<string, string>] | undefined
) => {
  let dataLength;
  let dataType;

  if (!input) {
    dataLength = 0;
    dataType = 'null';
  }
  else if (Array.isArray(input)) {
    dataLength = input.length;
    dataType = 'array';
  }
  else if (typeof input === 'object') {
    dataLength = new Blob([JSON.stringify(input)]).size;
    dataType = 'object';
  } else if (typeof input === 'string') {
    dataLength = input.length;
    dataType = 'string';
  } else if (typeof input === 'number') {
    dataLength = (input as number).toString().length;
    dataType = Number.isInteger(input) ? 'integer' : 'float';
  } else if (typeof input === 'boolean') {
    dataLength = 1;
    dataType = 'boolean';
  }
  return { length: dataLength, type: dataType };
};

const prepareData = (
  event: EventRequestType,
  remoteConfig: RemoteConfigType,
) => {
  const { event: redactedEvent, sensitiveKeyMetadata } = redactValuesFromKeys(event, remoteConfig);
  return ({
    ...redactedEvent,
    metadata: { sensitiveKeys: sensitiveKeyMetadata }
  })
};

const post = async (
  url: string,
  data: Array<EventRequestType> | ErrorPayloadType | TelemetryType,
  authorization: string
): Promise<string> => {
  const dataString = JSON.stringify(data);
  const packageVersion = version;
  const response = await fetch(url, {
    method: 'POST',
    mode: 'no-cors',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authorization,
      'supergood-api': 'supergood-browser',
      'supergood-api-version': packageVersion
    },
    body: dataString,
  });
  return response.json();
}

const get = async (
  url: string,
  authorization: string
): Promise<string> => {
  const packageVersion = version;

  const options = {
    method: 'GET',
    headers: {
      Authorization: authorization,
      'supergood-api': 'supergood-js',
      'supergood-api-version': packageVersion,
      mode: 'no-cors',
    },
  };

  const response = await fetch(url, options);
  return response.json();
}

const processRemoteConfig = (remoteConfigPayload: RemoteConfigPayloadType) => {
  return (remoteConfigPayload || []).reduce((remoteConfig, domainConfig) => {
    const { domain, endpoints } = domainConfig;
    const endpointConfig = endpoints.reduce((endpointConfig, endpoint) => {
      const { matchingRegex, endpointConfiguration } = endpoint;
      const { regex, location } = matchingRegex;
      const { action, sensitiveKeys } = endpointConfiguration;
      endpointConfig[regex] = {
        location,
        regex,
        ignored: action === 'Ignore',
        sensitiveKeys: (sensitiveKeys || []).map((key) => key.keyPath)
      };
      return endpointConfig;
    }, {} as { [endpointName: string]: EndpointConfigType });
    remoteConfig[domain] = endpointConfig;
    return remoteConfig;
  }, {} as RemoteConfigType);
}

const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const getStrRepresentationFromPath = (request: RequestType, location: string) => {
  const url = new URL(request.url);
  if (location === 'domain') return url.hostname.toString();
  if (location === 'url') return url.toString();
  if (location === 'path') return url.pathname.toString();
  if (location === 'requestHeaders') return request.headers.toString();
  if (location === 'requestBody') return request.body?.toString();
  return request[location as keyof RequestType]?.toString();
}

const getEndpointConfigForRequest = (request: RequestType, remoteConfig: RemoteConfigType) => {
  const domains = Object.keys(remoteConfig);
  const domain = domains.find((domain) => request.url.includes(domain));

  // If the domain doesn't exist in the config, then we return nothing
  if (!domain) return null;
  const endpointConfigs = remoteConfig[domain];

  for (let i = 0; i < Object.keys(endpointConfigs).length; i++) {
    const endpointConfig = endpointConfigs[Object.keys(endpointConfigs)[i]];
    const { regex, location } = endpointConfig;
    const regexObj = new RegExp(regex);
    const strRepresentation = getStrRepresentationFromPath(request, location);
    if (!strRepresentation) continue;
    else {
      const match = regexObj.test(strRepresentation);
      if (match) {
        return endpointConfig;
      }
    }
  }
  return null;
}

export {
  processRemoteConfig,
  getHeaderOptions,
  redactValue,
  redactValuesFromKeys,
  logger,
  safeParseJson,
  prepareData,
  sleep,
  post,
  get,
  getEndpointConfigForRequest,
  expandSensitiveKeySetForArrays
};
