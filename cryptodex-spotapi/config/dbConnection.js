// import package
import mongoose from 'mongoose';

// import config
import config from './index.js';

const dbConnection = (cb) => {
    // Log the target WITHOUT credentials. A mongo URI carries a password, and
    // this runs on every connect attempt straight onto Railway's log stream -
    // it used to print the raw URI, defeating the supervisor's own masking of
    // the same value. Greedy up to the LAST '@' so a password containing '@' is
    // still fully covered.
    const safeUri = String(config.DATABASE_URI || '').replace(/(\/\/)[^/]*@/, '$1***@');
    console.log('MongoDB target:', safeUri)

    mongoose.connect(config.DATABASE_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
    }, (err, data) => {
        if (err) {
            // err.message only: the full error object can echo the connection
            // string (and thus the password) back into the logs.
            console.log("\x1b[31m", 'Error on Database connection:', err.message)
            setTimeout(() => {
                dbConnection(cb)
            }, 1000)
        } else {
            console.log('\x1b[33m%s\x1b[0m', `MongoDB successfully connected.`)
            return cb(true)
        }
    })
}

export default dbConnection;