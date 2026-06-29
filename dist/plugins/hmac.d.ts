import type { FastifyPluginAsync } from 'fastify';
declare module 'fastify' {
    interface FastifyRequest {
        operatorId: string;
        isAdmin: boolean;
    }
}
declare const _default: FastifyPluginAsync;
export default _default;
