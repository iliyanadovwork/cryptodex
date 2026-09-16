// import package
import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import http from 'http'
import passport from 'passport';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
// import config
import config from './config/index.js';
import dbConnection from './config/dbConnection.js';
import { createSocketIO } from './config/socketIO.js';
import { usersAuth } from "./config/passport.js";
import { cleanupUnactivatedAccounts } from './config/cron.js';
// import lib
import { responseGuard } from './lib/responseGuard.js';
// import routes
import authAPI from './routes/auth.route.js';
import healthAPI from './routes/health.route.js';
import languageAPI from './routes/language.route.js';
import userAPI from './routes/user.route.js';


const app = express();
app.use(morgan("dev"))
app.use(cors({ origin: '*' }));
// SECURITY: guarantee every request eventually gets a response so a handler that
// swallows an error without replying cannot leak connections forever.
// 60s is chosen to sit well above the slowest legitimate request while still
// bounding a leaked connection. Streaming responses are unaffected: once headers
// are sent the guard stands down.
app.use(responseGuard(60000));
// Increase the limit to 10MB (you can adjust this as needed)

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: false }));

// passport
app.use(passport.initialize());
usersAuth(passport)

const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(__dirname + '/public'));

// Unauthenticated liveness probe. Mounted before the authenticated routers so
// it can never end up behind passport, and so it still answers when the rest of
// the service cannot.
app.use('/api/health', healthAPI)

app.use('/api/auth', authAPI)
app.use('/api/language', languageAPI)
app.use('/api/user', userAPI)

//App Use
app.use('/app/language', languageAPI)
app.use('/app/user', userAPI)
app.use('/app/auth', authAPI)

app.get('/', (req, res) => {
  return res.send("Successfully Testing")
})

let server = http.createServer(app);
createSocketIO(server)
// DATABASE CONNECTION
dbConnection((done) => {
  if (done) {
    server = server.listen(config.PORT, function () {
      console.log('\x1b[34m%s\x1b[0m', `server is running on port ${config.PORT}`);
      import('./grpc/server.js')
    });

    // Start cron job to cleanup unactivated accounts after 3 minutes
    cleanupUnactivatedAccounts.start();
    console.log('\x1b[36m%s\x1b[0m', 'Cron job started: Cleanup unactivated accounts');
  }
})
