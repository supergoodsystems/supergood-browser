import Supergood from '..';
import { postEvents, postError } from '../api';
import { dumpDataToDisk } from '../utils';
import { initialize } from './json-server-config';
import { errors } from '../constants';
import {
  afterAll,
  expect,
  test,
  jest,
  describe,
  beforeAll,
  beforeEach
} from '@jest/globals';
import { ErrorPayloadType, EventRequestType } from '../types';
import initialDB from './initial-db';
import http from 'http';
import fs from 'fs';
import path from 'path';

// HTTP libraries
import superagent from 'superagent';
import axios from 'axios';
import fetch from 'node-fetch';

const base64Regex =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Local JSON server configuration for sending arbitrary POST/GET requests
// to a random CRUD server
const CLIENT_ID = process.env.CLIENT_ID || 'test-client-id';
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'test-client-secret';

const HTTP_OUTBOUND_TEST_SERVER = `http://localhost:${process.env.HTTP_OUTBOUND_TEST_SERVER_PORT}`;

const SUPERGOOD_SERVER_PORT = process.env.SUPERGOOD_SERVER_PORT || 9001;
const INTERNAL_SUPERGOOD_SERVER = `http://localhost:${SUPERGOOD_SERVER_PORT}`;

const testOptions = {
  flushInterval: 30000,
  cacheTtl: 0,
  baseUrl: INTERNAL_SUPERGOOD_SERVER,
  eventSinkEndpoint: `/api/events`,
  errorSinkEndpoint: `/api/errors`,
  hashBody: false
};

let server: http.Server;

beforeAll(async () => {
  fs.writeFileSync(
    path.join(__dirname, 'db.json'),
    JSON.stringify(initialDB, null, 2),
    {
      encoding: 'utf8',
      flag: 'w'
    }
  );
  server = await initialize();
});

afterAll(async () => {
  server.close();
  fs.writeFileSync(
    path.join(__dirname, 'db.json'),
    JSON.stringify(initialDB, null, 2),
    {
      encoding: 'utf8',
      flag: 'w'
    }
  );
});

const getEvents = (mockedPostEvents: jest.Mock): Array<EventRequestType> =>
  Object.values(mockedPostEvents.mock.calls.flat()[1] as EventRequestType);

const getErrors = (mockedPostError: jest.Mock): ErrorPayloadType => {
  return Object.values(
    mockedPostError.mock.calls.flat()
  )[1] as ErrorPayloadType;
};

jest.mock('../api', () => ({
  postEvents: jest.fn(async (eventSinkUrl, data) => ({ data })),
  postError: jest.fn(async (errorSinkUrl, payload, options) => ({
    payload
  }))
}));

jest.mock('../utils', () => {
  const originalFunctions = Object(jest.requireActual('../utils'));
  return {
    ...originalFunctions,
    dumpDataToDisk: jest.fn((data, log, config) => ({ data, config }))
  };
});

describe('testing success states', () => {
  test('captures all outgoing 200 http requests', async () => {
    const sg = Supergood(
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET
      },
      testOptions
    );

    const numberOfHttpCalls = 5;
    for (let i = 0; i < numberOfHttpCalls; i++) {
      await axios.get(`${HTTP_OUTBOUND_TEST_SERVER}/posts`);
    }
    await sg.close();
    const eventsPosted = getEvents(postEvents as jest.Mock);
    expect(eventsPosted.length).toEqual(numberOfHttpCalls);
    expect(
      eventsPosted.every((event) => event.request.requestedAt)
    ).toBeTruthy();
    expect(
      eventsPosted.every((event) => event.response.respondedAt)
    ).toBeTruthy();
    await sg.close();
  });

  test('captures non-success status and errors', async () => {
    const httpErrorCodes = [400, 401, 403, 404, 500, 501, 502, 503, 504];
    const sg = Supergood(
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET
      },
      testOptions
    );
    for (let i = 0; i < httpErrorCodes.length; i++) {
      try {
        await axios.get(`${HTTP_OUTBOUND_TEST_SERVER}/${httpErrorCodes[i]}`);
      } catch (e) {
        // ignore
      }
    }
    await sg.close();
    const eventsPosted = getEvents(postEvents as jest.Mock);
    expect(eventsPosted.length).toEqual(httpErrorCodes.length);
    expect(
      eventsPosted.every((event) =>
        httpErrorCodes.includes(event.response.status)
      )
    ).toBeTruthy();
  });
});

describe('testing failure states', () => {
  test('hanging response', async () => {
    const sg = Supergood(
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET
      },
      testOptions
    );
    axios.get(`${HTTP_OUTBOUND_TEST_SERVER}/200?sleep=2000`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await sg.close();
    const eventsPosted = getEvents(postEvents as jest.Mock);
    const firstEvent = eventsPosted[0];
    expect(eventsPosted.length).toEqual(1);
    expect(firstEvent.request.requestedAt).toBeTruthy();
    expect(firstEvent?.response?.respondedAt).toBeFalsy();
  });

  test('posting errors', async () => {
    (postEvents as jest.Mock).mockImplementation(() => {
      throw new Error();
    });
    const sg = Supergood(
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET
      },
      testOptions
    );
    await axios.get(`${HTTP_OUTBOUND_TEST_SERVER}/posts`);
    await sg.close();
    const postedErrors = getErrors(postError as jest.Mock);
    expect(dumpDataToDisk as jest.Mock).toBeCalled();
    expect(postError as jest.Mock).toBeCalled();
    expect(postedErrors.message).toEqual(errors.POSTING_EVENTS);
  });
});

describe('hashing request and response bodies', () => {
  test('hashing', async () => {
    const sg = Supergood(
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET
      },
      { ...testOptions, hashBody: true }
    );
    await axios.get(`${HTTP_OUTBOUND_TEST_SERVER}/posts`);
    await sg.close();
    const eventsPosted = getEvents(postEvents as jest.Mock);
    const firstEvent = eventsPosted[0] as EventRequestType;
    expect(firstEvent.response.body.hashed.match(base64Regex)).toBeTruthy();
  });

  test('not hashing', async () => {
    const sg = Supergood(
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET
      },
      testOptions
    );
    await axios.get(`${HTTP_OUTBOUND_TEST_SERVER}/posts`);
    await sg.close();
    const eventsPosted = getEvents(postEvents as jest.Mock);
    const firstEvent = eventsPosted[0] as EventRequestType;
    expect(firstEvent.response.body.hashed).toBeFalsy();
  });
});

describe('testing various endpoints and libraries basic functionality', () => {
  let sg: { close: () => Promise<void>; flushCache: () => Promise<void> };

  beforeEach(() => {
    sg = Supergood(
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET
      },
      testOptions
    );
  });

  test('axios get', async () => {
    const response = await axios.get(`${HTTP_OUTBOUND_TEST_SERVER}/posts`);
    expect(response.status).toEqual(200);
    await sg.close();
    const eventsPosted = getEvents(postEvents as jest.Mock);
    expect(eventsPosted.length).toEqual(1);
  });

  test('axios post', async () => {
    const response = await axios.post(`${HTTP_OUTBOUND_TEST_SERVER}/posts`, {
      title: 'axios-post',
      author: 'alex-klarfeld'
    });
    expect(response.status).toEqual(201);
    await sg.close();
    const eventsPosted = getEvents(postEvents as jest.Mock);
    expect(eventsPosted.length).toEqual(1);
  });

  test('superagent get', async () => {
    const response = await superagent.get(`${HTTP_OUTBOUND_TEST_SERVER}/posts`);
    expect(response.status).toEqual(200);
    await sg.close();
    const eventsPosted = getEvents(postEvents as jest.Mock);
    expect(eventsPosted.length).toEqual(1);
  });

  test('superagent post', async () => {
    const response = await superagent
      .post(`${HTTP_OUTBOUND_TEST_SERVER}/posts`)
      .send({
        title: 'superagent-post',
        author: 'alex-klarfeld'
      });
    expect(response.status).toEqual(201);
    await sg.close();
    const eventsPosted = getEvents(postEvents as jest.Mock);
    expect(eventsPosted.length).toEqual(1);
  });

  test('node-fetch get', async () => {
    const response = await fetch(`${HTTP_OUTBOUND_TEST_SERVER}/posts`);
    const body = await response.text();
    expect(response.status).toEqual(200);
    expect(body).toBeTruthy();
    await sg.close();
    const eventsPosted = getEvents(postEvents as jest.Mock);
    expect(eventsPosted.length).toEqual(1);
  });

  test('node-fetch post', async () => {
    const response = await fetch(`${HTTP_OUTBOUND_TEST_SERVER}/posts`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'node-fetch-post'
      })
    });
    const responseJson = await response.json();
    expect(response.status).toEqual(201);
    expect(responseJson.id).toBeTruthy();
    await sg.close();
    const eventsPosted = getEvents(postEvents as jest.Mock);
    expect(eventsPosted.length).toEqual(1);
  });
});

// Perhaps even need to write a restore from disk method?
// test('write to disk when connection fails', () => {});
