import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config/env';

const corsPlugin: FastifyPluginAsync = async (fastify) => {
  const allowedOrigins =
    env.NODE_ENV === 'production'
      ? ['https://unipaycongo.com', 'https://www.unipaycongo.com', 'https://app.unipaycongo.com', 'https://api.unipaycongo.com']
      : true;

  await fastify.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Admin-Secret', 'X-PredictStreet-Signature', 'X-UniPay-Signature'],
    credentials: true,
  });
};

export default fp(corsPlugin, { name: 'cors-plugin' });
