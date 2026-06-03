import 'dotenv/config';
import { buildServer } from './server';
import { env } from './config/env';

const start = async () => {
  const server = await buildServer();

  try {
    await server.listen({ port: parseInt(env.PORT), host: '0.0.0.0' });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

start();
