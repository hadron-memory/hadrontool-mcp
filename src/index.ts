import { createApp } from './app.js';
import { config } from './config.js';
import { logInfo } from './logger.js';

const app = createApp();
app.listen(config.port, () => {
  logInfo(`listening on :${config.port}`);
});
