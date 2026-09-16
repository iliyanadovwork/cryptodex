import React from "react";
import Head from "next/head";
import config from "../config/index";
export default function Meta({ keyWords, tittle, description }) {
  return (
    <Head>
      <title>{tittle ? tittle : config.SITE_NAME}</title>
      <meta
        name="description"
        content={description ? description : config.SITE_DISCRIPTION}
      />
      <meta
        name="keywords"
        content={keyWords ? keyWords : config.SITE_KEYWORDS}
      />

      <link rel="icon" href="/favicon.png" />
    </Head>
  );
}
