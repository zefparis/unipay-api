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
/** Common error status codes used across the API. */
export declare const errorResponses: {
    readonly 400: {
        type: string;
        properties: {
            error: {
                type: string;
            };
            statusCode: {
                type: string;
            };
        };
    };
    readonly 401: {
        type: string;
        properties: {
            error: {
                type: string;
            };
            statusCode: {
                type: string;
            };
        };
    };
    readonly 403: {
        type: string;
        properties: {
            error: {
                type: string;
            };
            statusCode: {
                type: string;
            };
        };
    };
    readonly 404: {
        type: string;
        properties: {
            error: {
                type: string;
            };
            statusCode: {
                type: string;
            };
        };
    };
    readonly 500: {
        type: string;
        properties: {
            error: {
                type: string;
            };
            statusCode: {
                type: string;
            };
        };
    };
    readonly 502: {
        type: string;
        properties: {
            error: {
                type: string;
            };
            statusCode: {
                type: string;
            };
        };
    };
};
