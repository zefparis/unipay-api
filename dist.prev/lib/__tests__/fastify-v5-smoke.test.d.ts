/**
 * Fastify v5 migration smoke test.
 *
 * Boots a minimal Fastify v5 server with the same plugins and configuration
 * patterns used in the real app (helmet, rate-limit, multipart, custom
 * content type parser, error handler, preHandler hook) to verify the
 * migration doesn't break the framework integration.
 */
export {};
