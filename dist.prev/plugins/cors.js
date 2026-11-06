"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const cors_1 = __importDefault(require("@fastify/cors"));
const env_1 = require("../config/env");
const corsPlugin = async (fastify) => {
    const allowedOrigins = env_1.env.NODE_ENV === 'production'
        ? [
            'https://unipaycongo.com',
            'https://www.unipaycongo.com',
            'https://app.unipaycongo.com',
            'https://api.unipaycongo.com',
            env_1.env.DEV_EXPENSES_PUBLIC_ORIGIN,
        ]
        : true;
    await fastify.register(cors_1.default, {
        origin: allowedOrigins,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Admin-Secret', 'X-UniPay-Signature'],
        credentials: true,
    });
};
exports.default = (0, fastify_plugin_1.default)(corsPlugin, { name: 'cors-plugin' });
//# sourceMappingURL=cors.js.map