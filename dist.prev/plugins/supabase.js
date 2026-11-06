"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const supabase_js_1 = require("@supabase/supabase-js");
const env_1 = require("../config/env");
const supabasePlugin = async (fastify) => {
    const client = (0, supabase_js_1.createClient)(env_1.env.SUPABASE_URL, env_1.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
    });
    fastify.decorate('supabase', client);
    fastify.log.info('Supabase client registered');
};
exports.default = (0, fastify_plugin_1.default)(supabasePlugin, { name: 'supabase-plugin' });
//# sourceMappingURL=supabase.js.map