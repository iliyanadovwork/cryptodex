// import package
import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import http from 'http'
import passport from 'passport';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
// import config
import config from './config/index.js';
import dbConnection from './config/dbConnection.js';
import { usersAuth } from "./config/passport.js";
import './config/cron.js';

// import routes
import healthAPI from './routes/health.route.js'
import currencyAPI from './routes/currency.route.js'
import commonAPI from './routes/common.route.js'
import walletAPI from './routes/wallet.route.js'


const app = express();
app.use(morgan("dev"))
app.use(cors({ origin: '*' }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
const __dirname = dirname(fileURLToPath(import.meta.url));
// passport
app.use(passport.initialize());
usersAuth(passport)

app.use(express.static(__dirname + '/public'));

// Health FIRST, before every authenticated router. It has to answer when auth
// is the thing that is broken - and passport's JWT strategy here reads the
// session row out of redis, so "redis is down" is exactly the outage that makes
// every other route on this service unreachable.
app.use('/api/health', healthAPI)

app.use('/api/currency', currencyAPI)
app.use('/api/common', commonAPI)
app.use('/api/wallet', walletAPI)

app.get('/', (req, res) => {
  return res.send("Successfully Testing")
})

let server = http.createServer(app);


// DATABASE CONNECTION
dbConnection((done) => {
  if (done) {
    server = server.listen(config.PORT, function () {
      console.log('\x1b[34m%s\x1b[0m', `server is running on port ${config.PORT}`);
      import('./grpc/server.js')
    });
  }
})
