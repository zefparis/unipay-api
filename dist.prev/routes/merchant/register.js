"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const email_js_1 = require("../../services/email.js");
const OPERATORS = ['orange', 'airtel', 'afrimoney'];
const registerRoute = async (fastify) => {
    fastify.post('/merchant/register', {
        config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req) => req.ip } },
        schema: {
            body: {
                type: 'object',
                required: ['name', 'email', 'password'],
                properties: {
                    name: { type: 'string', minLength: 2, maxLength: 128 },
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', minLength: 8, maxLength: 128 },
                    phone: { type: 'string', maxLength: 32 },
                    country: { type: 'string', maxLength: 8 },
                    company_name: { type: 'string', maxLength: 256 },
                    company_rccm: { type: 'string', maxLength: 128 },
                    company_idnat: { type: 'string', maxLength: 128 },
                },
            },
            response: {
                201: {
                    type: 'object',
                    properties: {
                        merchant_id: { type: 'string' },
                        name: { type: 'string' },
                        email: { type: 'string' },
                        api_key: { type: ['string', 'null'] },
                        message: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        const { name, email, password, phone, country, company_name, company_rccm, company_idnat } = request.body;
        // 1. Check email uniqueness in merchants table
        const { data: existing } = await fastify.supabase
            .from('merchants')
            .select('id')
            .eq('email', email)
            .maybeSingle();
        if (existing) {
            return reply.status(409).send({ error: 'Email already registered', statusCode: 409 });
        }
        // 2. Hash password
        const passwordHash = await bcryptjs_1.default.hash(password, 12);
        // 3. Insert merchant
        const { data: merchant, error: merchantError } = await fastify.supabase
            .from('merchants')
            .insert({
            name,
            email,
            password_hash: passwordHash,
            phone: phone ?? null,
            country: country ?? 'CD',
            status: 'active',
            access_status: 'kyc_required', // conformité : aucune clé API avant validation du dossier
            kyc_status: 'pending',
            company_name: company_name ?? null,
            company_rccm: company_rccm ?? null,
            company_idnat: company_idnat ?? null,
        })
            .select('id')
            .single();
        if (merchantError || !merchant) {
            fastify.log.error({ err: merchantError, email }, 'Merchant insert failed');
            return reply.status(500).send({ error: 'Registration failed', statusCode: 500 });
        }
        const merchantId = merchant.id;
        // 4. Create one operators row per operator
        const operatorRows = OPERATORS.map((op) => ({
            merchant_id: merchantId,
            operator: op,
            balance_cdf: 0,
            status: 'active',
        }));
        const { error: opError } = await fastify.supabase
            .from('operators')
            .insert(operatorRows);
        if (opError) {
            fastify.log.error({ err: opError, merchantId }, 'Operator rows creation failed');
        }
        // 5. Pas de clé API : le compte démarre en access_status='kyc_required',
        // la clé (sandbox puis live) sera émise par un admin après validation
        // des 3 documents obligatoires.
        fastify.log.info({ merchantId, email }, 'Merchant registered');
        // Fire welcome email — non-blocking (M7: no API key in email)
        (0, email_js_1.sendWelcomeEmail)(email, name).catch((err) => {
            fastify.log.error({ err, email }, 'Welcome email failed');
        });
        // Notify admin of new registration — non-blocking
        (0, email_js_1.sendAdminNewMerchantEmail)(name, email, company_name ?? '').catch((err) => {
            fastify.log.error({ err, email }, 'Admin notification email failed');
        });
        return reply.status(201).send({
            merchant_id: merchantId,
            name,
            email,
            api_key: null,
            message: 'Compte créé. Envoyez vos documents KYC depuis votre espace marchand pour activer votre accès.',
        });
    });
};
exports.default = registerRoute;
//# sourceMappingURL=register.js.map