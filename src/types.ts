import { IsomorphicRequest, IsomorphicResponse } from '@mswjs/interceptors';

interface HeaderOptionType {
  headers: {
    'Content-Type': string;
    Authorization: string;
  };
}

type BodyType = Record<string, string>;

interface RequestType {
  id: string;
  method: string;
  url: string;
  protocol: string;
  domain: string;
  path: string;
  search: string;
  body?: string | BodyType | [BodyType];
  requestedAt: Date;
}

interface ResponseType {
  status: number;
  statusText: string;
  body?: string | BodyType | [BodyType];
  respondedAt: Date;
}

interface ConfigType {
  flushInterval: number;
  ignoredDomains: string[];
  cacheTtl: number;
  keysToHash: string[];
  eventSinkEndpoint: string; // Defaults to {baseUrl}/api/events if not provided
  errorSinkEndpoint: string; // Defaults to {baseUrl}/api/errors if not provided
}

interface EventRequestType {
  request: RequestType;
  response: ResponseType;
}

// interface EventResponseType {}

type ErrorPayloadType = {
  payload: InfoPayloadType;
  error: string;
  message: string;
};

// interface ErrorResponseType {}

interface InfoPayloadType {
  config: ConfigType;
  request?: IsomorphicRequest;
  response?: IsomorphicResponse;
  data?: EventRequestType[];
  packageName?: string;
  packageVersion?: string;
}

interface LoggerType {
  error: (message: string, payload: InfoPayloadType, error: Error) => void;
  info: (message: string, payload?: InfoPayloadType) => void;
}

export type {
  HeaderOptionType,
  RequestType,
  ResponseType,
  EventRequestType,
  InfoPayloadType,
  LoggerType,
  ConfigType,
  ErrorPayloadType
};
