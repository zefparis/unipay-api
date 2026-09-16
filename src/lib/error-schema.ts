/**
 * Shared error response schema for Fastify v5.
 *
 * In Fastify v5, `reply.status()` is typed based on the response schema keys.
 * Routes that return error status codes (400, 401, 403, 404, 500, 502) must
 * declare those codes in their response schema, otherwise TypeScript
 * rejects the `reply.status(code)` call.
 *
 * This module provides reusable error response schema fragments that can
 * be spread into a route's response schema.
 */

const errorProperties = {
  type: 'object',
  properties: {
    error:      { type: 'string' },
    statusCode: { type: 'number' },
  },
};

/** Common error status codes used across the API. */
export const errorResponses = {
  400: errorProperties,
  401: errorProperties,
  403: errorProperties,
  404: errorProperties,
  500: errorProperties,
  502: errorProperties,
} as const;
