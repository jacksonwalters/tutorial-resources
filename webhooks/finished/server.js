"use strict";
require("dotenv").config();
const fs = require("fs/promises");
const express = require("express");
const bodyParser = require("body-parser");
const moment = require("moment");
const {
  Configuration,
  PlaidEnvironments,
  PlaidApi,
  SandboxItemFireWebhookRequestWebhookCodeEnum,
  WebhookType,
} = require("plaid");

const APP_PORT = process.env.APP_PORT || 8000;
const USER_DATA_FILE = "user_data.json";

const FIELD_ACCESS_TOKEN = "accessToken";
const FIELD_USER_STATUS = "userStatus";

let webhookUrl =
  process.env.WEBHOOK_URL || "https://www.example.com/plaid_webhook";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static("public"));

const server = app.listen(APP_PORT, function () {
  console.log(`Server is up and running at http://localhost:${APP_PORT}/`);
});

// Set up the Plaid client
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
      "Plaid-Version": "2020-09-14",
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

const getUserRecord = async function () {
  try {
    const userData = await fs.readFile(USER_DATA_FILE, {
      encoding: "utf8",
    });
    const userDataObj = await JSON.parse(userData);
    console.log(`Retrieved userData ${userData}`);
    return userDataObj;
  } catch (error) {
    // Might happen first time, if file doesn't exist
    console.log("Got an error", error);
    return null;
  }
};

let userRecord;
(async () => {
  userRecord = await getUserRecord();
  if (userRecord == null) {
    userRecord = {};
    userRecord[FIELD_ACCESS_TOKEN] = null;
    userRecord[FIELD_USER_STATUS] = "disconnected";
  }
})();

/**
 * Updates the user record in memory and writes it to a file. In a real
 * application, you'd be writing to a database.
 */
const updateUserRecord = async function (key, val) {
  userRecord[key] = val;
  try {
    const dataToWrite = JSON.stringify(userRecord);
    await fs.writeFile(USER_DATA_FILE, dataToWrite, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(`User record ${dataToWrite} written to file.`);
  } catch (error) {
    console.log("Got an error: ", error);
  }
};

/**
 * Just returns whether or not we're connected to Plaid
 */
app.get("/server/get_user_info", async (req, res, next) => {
  try {
    res.json({
      user_status: userRecord[FIELD_USER_STATUS],
    });
  } catch (error) {
    next(error);
  }
});

const basicLinkTokenObject = {
  user: { client_user_id: "testUser" },
  client_name: "Webhook Test App",
  language: "en",
  products: ["transactions", "assets"],
  country_codes: ["US"],
  webhook: webhookUrl,
};

/**
 * Generates a link token to be used by the client.
 */
app.post("/server/generate_link_token", async (req, res, next) => {
  try {
    const response = await plaidClient.linkTokenCreate(basicLinkTokenObject);
    console.log(basicLinkTokenObject);
    res.json(response.data);
  } catch (error) {
    console.log(`Running into an error!`);
    next(error);
  }
});

/**
 * Swap the public token for an access token, so we can access transaction info
 * in the future
 */
app.post("/server/swap_public_token", async (req, res, next) => {
  try {
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: req.body.public_token,
    });
    console.log(`You got back ${JSON.stringify(response.data)}`);
    await updateUserRecord(FIELD_ACCESS_TOKEN, response.data.access_token);
    await updateUserRecord(FIELD_USER_STATUS, "connected");

    res.json({ status: "success" });
  } catch (error) {
    next(error);
  }
});

/**
 * Grabs transaction info for the user and return it as a big ol' JSON object
 */
app.get("/server/transactions", async (req, res, next) => {
  try {
    const access_token = await userRecord[FIELD_ACCESS_TOKEN];
    const startDate = moment().subtract(30, "days").format("YYYY-MM-DD");
    const endDate = moment().format("YYYY-MM-DD");

    const transactionResponse = await plaidClient.transactionsGet({
      access_token: access_token,
      start_date: startDate,
      end_date: endDate,
      options: { count: 10 },
    });
    res.json(transactionResponse.data);
  } catch (error) {
    next(error);
  }
});

// Fetches balance data
app.get("/server/balances", async (req, res, next) => {
  try {
    const access_token = userRecord[FIELD_ACCESS_TOKEN];
    const balanceResponse = await plaidClient.accountsBalanceGet({
      access_token: access_token,
      options: {
        min_last_updated_datetime: "2020-01-01T00:00:00Z",
      },
    });
    res.json(balanceResponse.data);
  } catch (error) {
    next(error);
  }
});

/**
 * Kicks off the request to create an asset report. In non-sandbox mode
 * this could take several minutes to complete.
 */
app.get("/server/create_asset_report", async (req, res, next) => {
  try {
    const access_token = userRecord[FIELD_ACCESS_TOKEN];
    const reportResponse = await plaidClient.assetReportCreate({
      access_tokens: [access_token],
      days_requested: 30,
      options: {
        user: { first_name: "Jane", last_name: "Foster" },
        webhook: webhookUrl,
      },
    });
    res.json(reportResponse.data);
  } catch (error) {
    next(error);
  }
});

/**
 * Ask Plaid to fire off a new webhook. Useful for testing webhooks... and
 * not much else.
 */
app.post("/server/fire_test_webhook", async (req, res, next) => {
  try {
    const access_token = userRecord[FIELD_ACCESS_TOKEN];
    const webhookResponse = await plaidClient.sandboxItemFireWebhook({
      access_token: access_token,
      webhook_type: WebhookType.Item,
      webhook_code:
        SandboxItemFireWebhookRequestWebhookCodeEnum.NewAccountsAvailable,
    });
    res.json(webhookResponse.data);
  } catch (error) {
    next(error);
  }
});

app.post("/server/update_webhook", async (req, res, next) => {
  try {
    console.log(`Update our webhook with ${JSON.stringify(req.body)}`);
    // Update the one we have in memory
    webhookUrl = req.body.newUrl;
    const access_token = userRecord[FIELD_ACCESS_TOKEN];
    const updateResponse = await plaidClient.itemWebhookUpdate({
      access_token: access_token,
      webhook: req.body.newUrl,
    });
    res.json(updateResponse.data);
  } catch (error) {
    next(error);
  }
});

app.post("/server/old_plaid_webhook", async (req, res, next) => {
  try {
    console.log(`This is what I received:`);
    console.dir(req.body, { colors: true, depth: null });
    res.json({ status: "received" });
  } catch (error) {
    next(error);
  }
});

const errorHandler = function (err, req, res, next) {
  console.error(`Your error:`);
  console.error(err);
  if (err.response?.data != null) {
    res.status(500).send(err.response.data);
  } else {
    res.status(500).send({
      error_code: "OTHER_ERROR",
      error_message: "I got some other message on the server.",
    });
  }
};
app.use(errorHandler);

/**
 * Our server running on a different port that we'll use for handling webhooks
 */
const compare = require("secure-compare");
const jwt_decode = require("jwt-decode");
const JWT = require("jose");
const sha256 = require("js-sha256");
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 8001;

const webhookApp = express();
webhookApp.use(bodyParser.urlencoded({ extended: false }));
webhookApp.use(
  bodyParser.json({
    verify: function (req, res, buf, encoding) {
      // get rawBody
      req.rawBody = buf.toString();
      req.bodyHash = sha256(req.rawBody);
    },
  })
);

const webhookServer = webhookApp.listen(WEBHOOK_PORT, function () {
  console.log(
    `Webhook receiver is up and running at http://localhost:${WEBHOOK_PORT}/`
  );
});

webhookApp.post("/server/plaid_webhook", async (req, res, next) => {
  try {
    console.log("Webhook received:");
    console.dir(req.body, { colors: true, depth: null });
    console.dir(req.headers, { colors: true, depth: null });

    if (await verifyWebhook(req)) {
      console.log("Webhook looks good!");
      const product = req.body.webhook_type;
      const code = req.body.webhook_code;
      if (product === "ITEM") {
        if (code === "ERROR") {
          console.log(
            `I received this error: ${req.body.error.error_message}| should probably ask this user to connect to their bank`
          );
        } else if (code === "NEW_ACCOUNTS_AVAILABLE") {
          console.log(
            `There are new accounts available at this Financial Institution! (Id:   ${req.body.item_id}) We might want to ask the user to share them with us`
          );
        } else if (code === "PENDING_EXPIRATION") {
          console.log(
            `We should tell our user to reconnect their bank with Plaid so there's no disruption to their service`
          );
        } else if (code === "USER_PERMISSION_REVOKED") {
          console.log(
            `The user revoked access to this item. We should remove it from our records`
          );
        } else if (code === "WEBHOOK_UPDATE_ACKNOWLEDGED") {
          console.log(`Hooray! You found the right spot!`);
        }
      } else if (product === "ASSETS") {
        if (code === "PRODUCT_READY") {
          console.log(
            `Looks like asset report ${req.body.asset_report_id} is ready to download`
          );
        } else if (code === "ERROR") {
          console.log(
            `I had an error generating this report: ${req.body.error.error_message}`
          );
        }
      } else if (product === "TRANSACTIONS") {
        // Most of these aren't needed if you use the new sync API!
        if (code === "INITIAL_UPDATE") {
          console.log(
            `First patch of transactions are done. There's ${req.body.new_transactions} available`
          );
        } else if (code === "HISTORICAL_UPDATE") {
          console.log(
            `Historical transactions are done. There's ${req.body.new_transactions} available`
          );
        } else if (code === "DEFAULT_UPDATE") {
          console.log(
            `New data is here! There's ${req.body.new_transactions} available`
          );
        } else if (code === "TRANSACTIONS_REMOVED") {
          console.log(
            `Looks like a few transactions have been reversed and should be removed from our records`
          );
        }
      }

      res.json({ status: "received" });
    } else {
      console.log("Webhook didn't pass verification!");
      res.status(401);
    }
  } catch (error) {
    next(error);
  }
});

const verifyWebhook = async (req) => {
  const verbose = false;
  try {
    const signedJwt = req.headers["plaid-verification"];
    const decodedToken = jwt_decode(signedJwt);
    // Extract the JWT header
    const decodedTokenHeader = jwt_decode(signedJwt, { header: true });
    // Extract the kid value from the header
    verbose &&
      console.log(
        `Your token is ${JSON.stringify(
          decodedToken
        )} with headers ${JSON.stringify(decodedTokenHeader)}`
      );
    const currentKeyID = decodedTokenHeader.kid;
    verbose && console.log(`Key ID is ${currentKeyID}`);
    const keyResponse = await plaidClient.webhookVerificationKeyGet({
      key_id: currentKeyID,
    });
    verbose &&
      console.log(`Your key from Plaid is ${JSON.stringify(keyResponse.data)}`);
    // TODO: Cache this so that I don't need to call this every time we receive
    // a webhook.
    const key = keyResponse.data["key"];
    const keyLike = await JWT.importJWK(key);
    const { payload } = await JWT.jwtVerify(signedJwt, keyLike, {
      maxTokenAge: "5 min",
    });
    verbose && console.log("JWT is verified");
    // `payload` should be the same as the decoded token body.
    verbose && console.log(payload);
    const requestBody = JSON.stringify(req.body);
    verbose && console.log(`Your body is ${requestBody}`);
    const bodyHash = req.bodyHash;
    const claimedBodyHash = payload.request_body_sha256;
    verbose &&
      console.log(
        `Body has is ${bodyHash} compared to what I got in the header ${claimedBodyHash}`
      );
    return compare(bodyHash, claimedBodyHash);
  } catch (error) {
    console.log(`Received an error attempting to verify the webhook:`);
    console.log(error);
    return false;
  }
};

webhookApp.use(errorHandler);
