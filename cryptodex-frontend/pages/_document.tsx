import { Html, Head, Main, NextScript, Script } from 'next/document'

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <script src="/static/datafeeds/udf/dist/bundle.js" />
      </Head >
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
