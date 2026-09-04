const axios = require("axios");
let requestToken ="";
const refresh_token = process.env.REFRESH_TOKEN;
const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;

const workspaceId = "1404913000003936002";

// In-flight refreshToken promise. When several callers (e.g. a bulk
// endpoint that fans out 10 parallel Analytics queries) all detect an
// expired token at the same moment, they each used to call
// refreshToken() — Zoho throttled the burst and returned "Access
// Denied". This shared promise lets them all await the same single
// refresh instead.
let refreshPromise = null;

// Zoho access tokens live 1 hour, and the OAuth endpoint itself is rate
// limited ("You have made too many requests continuously"). So:
//  · a token refreshed within TOKEN_FRESH_MS is simply reused — pre-warm
//    calls (one per bulk endpoint hit) become free instead of burning an
//    OAuth request per dialog open;
//  · reactive callers (just saw INVALID_OAUTHTOKEN) reuse a token that
//    was refreshed within REFRESH_GRACE_MS — their failure happened with
//    the OLD token while someone else was already refreshing (the
//    "straggler" race that used to fire extra OAuth calls);
//  · after a FAILED refresh (throttled), FAIL_COOLDOWN_MS blocks
//    re-attempts so a burst of failing requests can't dig the throttle
//    hole deeper.
let lastRefreshAt = 0; // last SUCCESSFUL refresh
let lastFailAt = 0;    // last FAILED refresh attempt
const TOKEN_FRESH_MS = 45 * 60 * 1000;
const REFRESH_GRACE_MS = 15 * 1000;
const FAIL_COOLDOWN_MS = 20 * 1000;

function isTokenExpired(data) {
  if (!data) return false;
  return (
    data.summary === "INVALID_OAUTHTOKEN" ||
    data.summary === "SECURITY_NEEDS_LOGIN" ||
    data.code === 14 ||
    data.code === 57 ||
    // The PUT/POST helpers wrap axios errors as { success, error: <zoho
    // body> }, so the auth codes can arrive nested.
    data.error?.code == 14 ||
    data.error?.code == 57 ||
    data.errorCode == 8535 ||
    data.errorCode == 7309
  );
}

// `force` = the caller just saw an INVALID_OAUTHTOKEN response (reactive
// path). Non-forced callers (pre-warms) reuse any token younger than
// TOKEN_FRESH_MS; forced callers only reuse one refreshed in the last few
// seconds (i.e. by a concurrent caller while their request was in flight).
async function refreshToken(force = false) {
  // If a refresh is already in flight, share that promise so a burst
  // of concurrent callers doesn't trigger N OAuth requests at once.
  if (refreshPromise) {
    return refreshPromise;
  }
  const now = Date.now();
  const freshWindow = force ? REFRESH_GRACE_MS : TOKEN_FRESH_MS;
  if (requestToken && now - lastRefreshAt < freshWindow) {
    return requestToken;
  }
  // A refresh just failed (likely OAuth throttling) — don't hammer the
  // endpoint; callers surface the stale-token error instead.
  if (now - lastFailAt < FAIL_COOLDOWN_MS) {
    return requestToken || null;
  }
  refreshPromise = (async () => {
    try {
      const response = await axios.post(
        "https://accounts.zoho.com/oauth/v2/token",
        null,
        {
          params: {
            refresh_token: refresh_token,
            client_id: client_id,
            client_secret: client_secret,
            redirect_uri: "https://www.example.com/oauth2callback",
            grant_type: "refresh_token",
          },
        }
      );

      requestToken = response.data.access_token;
      lastRefreshAt = Date.now();
      // Deliberately not logging the token value itself.
      console.log("Zoho access token refreshed.");
      return requestToken;
    } catch (error) {
      lastFailAt = Date.now();
      console.error(
        "Error refreshing token:",
        error.response?.data || error.message
      );
      // Return null so callers know the refresh failed; their existing
      // null-check logic surfaces the error to the user.
      return null;
    } finally {
      // Clear the gate so the next genuine expiry triggers a fresh
      // refresh. (If we leave it set, a later expiry would resolve
      // instantly to the now-stale token.)
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function createExportJob(viewId) {
  const fetchData = async (requestViewId) => {
    try {
      const response = await axios.get(
        `https://analyticsapi.zoho.com/restapi/v2/bulk/workspaces/${workspaceId}/views/${requestViewId}/data?CONFIG=%7B%22responseFormat%22:%22json%22%7D`,
        {
          headers: {
            "ZANALYTICS-ORGID": "644732419",
            Authorization: `Zoho-oauthtoken ${requestToken}`,
          },
        }
      );
      return response.data;
    } catch (error) {
      console.log(
        "Error fetching data:",
        error.response?.data || error.message
      );
      return error.response?.data;
    }
  };

  try {
    let data = await fetchData(viewId);

    if (isTokenExpired(data)) {
      console.log("Token Expired! Refreshing...");
      const newAccessToken = await refreshToken(true); // reactive: this call just saw INVALID_OAUTHTOKEN
      if (!newAccessToken) {
        throw new Error("Failed to refresh token.");
      }
      data = await fetchData(viewId);
    }
    return data.data.jobId;
  } catch (error) {
    console.error("Error in createExportJob:", error);
  }
}

async function getJobData(jobId, retries = 5, delay = 30000) {
  if (!jobId) {
    console.log("No JobId Provided!");
    return;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (attempt === 1) {
        console.log(`Waiting ${delay / 1000} seconds for job to process...`);
      } else {
        console.log(`Retrying in ${delay / 1000} seconds...`);
      }
      await new Promise((res) => setTimeout(res, delay));

      const response = await axios.get(
        `https://analyticsapi.zoho.com/restapi/v2/bulk/workspaces/${workspaceId}/exportjobs/${jobId}/data`,
        {
          headers: {
            "ZANALYTICS-ORGID": "644732419",
            Authorization: `Zoho-oauthtoken ${requestToken}`,
          },
        }
      );

      return response.data;
    } catch (error) {
      console.log(error);
      console.warn(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt === retries) {
        throw new Error("Failed to fetch job data after multiple attempts.");
      }
    }
  }
}

async function getViewData(url) {
  const fetchData = async () => {
    try {
      const response = await axios.get(url, {
        headers: {
          "ZANALYTICS-ORGID": "644732419",
          Authorization: `Zoho-oauthtoken ${requestToken}`,
        },
      });
      return response.data;
    } catch (error) {
      console.log(
        "Error fetching data:",
        error.response?.data || error.message
      );
      return error.response?.data;
    }
  };

  try {
    let data = await fetchData();

    if (isTokenExpired(data)) {
      console.log("Token Expired! Refreshing...");
      const newAccessToken = await refreshToken(true); // reactive: this call just saw INVALID_OAUTHTOKEN
      if (!newAccessToken) {
        throw new Error("Failed to refresh token.");
      }
      data = await fetchData();
    }
    return data.data;
  } catch (error) {
    console.error("Error in createExportJob:", error);
  }
}

async function handleZohoInventoryRequest(url) {
  const fetchData = async (requestUrl) => {
    try {
      const response = await axios.get(requestUrl, {
        headers: {
          Authorization: `Zoho-oauthtoken ${requestToken}`,
        },
      });
      return response.data;
    } catch (error) {
      console.log(
        "Error fetching data:",
        error.response?.data || error.message
      );
      return error.response?.data;
    }
  };

  try {
    let data = await fetchData(url);

    if (isTokenExpired(data)) {
      console.log("Token Expired! Refreshing...");
      const newAccessToken = await refreshToken(true); // reactive: this call just saw INVALID_OAUTHTOKEN
      if (!newAccessToken) {
        throw new Error("Failed to refresh token.");
      }
      data = await fetchData(url);
    }
    return data;
  } catch (error) {
    console.error("Error in createExportJob:", error);
  }
}

async function handleZohoInventoryPostRequest(url, params) {
  const fetchData = async (requestUrl, requestBody) => {
    // console.log(
    //   `https://analyticsapi.zoho.com/restapi/v2/bulk/workspaces/${workspaceId}/views/${requestViewId}/data?CONFIG=%7B%22responseFormat%22:%22json%22%7D`
    // );
    try {
      const response = await axios.post(requestUrl, requestBody, {
        headers: {
          Authorization: `Zoho-oauthtoken ${requestToken}`,
        },
      });
      return response.data;
    } catch (error) {
      console.log(
        "Error fetching data:",
        error.response?.data || error.message
      );
      return error.response?.data;
    }
  };

  try {
    let data = await fetchData(url, params);

    if (isTokenExpired(data)) {
      console.log("Token Expired! Refreshing...");
      const newAccessToken = await refreshToken(true); // reactive: this call just saw INVALID_OAUTHTOKEN
      if (!newAccessToken) {
        throw new Error("Failed to refresh token.");
      }
      data = await fetchData(url, params);
    }
    return data;
  } catch (error) {
    console.error("Error in createExportJob:", error);
  }
}

// Same token-refresh dance as handleZohoInventoryPostRequest, but POSTs a
// multipart/form-data body (built with the `form-data` package). Used for
// endpoints like /salesorders/:id/attachment that accept file uploads.
async function handleZohoInventoryMultipartPostRequest(url, formData) {
  const formHeaders =
    formData && typeof formData.getHeaders === "function"
      ? formData.getHeaders()
      : {};

  const fetchData = async (requestUrl, body) => {
    try {
      const response = await axios.post(requestUrl, body, {
        headers: {
          Authorization: `Zoho-oauthtoken ${requestToken}`,
          ...formHeaders,
        },
        // PDFs etc. can be larger than axios's default 10 MB body limit.
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return response.data;
    } catch (error) {
      console.log(
        "Error uploading multipart:",
        error.response?.data || error.message
      );
      return error.response?.data;
    }
  };

  try {
    let data = await fetchData(url, formData);

    if (isTokenExpired(data)) {
      console.log("Token Expired! Refreshing...");
      const newAccessToken = await refreshToken(true); // reactive: this call just saw INVALID_OAUTHTOKEN
      if (!newAccessToken) {
        throw new Error("Failed to refresh token.");
      }
      data = await fetchData(url, formData);
    }
    return data;
  } catch (error) {
    console.error("Error in handleZohoInventoryMultipartPostRequest:", error);
  }
}

async function handleZohoInventoryPutRequest(url, params) {
  const fetchData = async (requestUrl, requestBody) => {
    try {
      const response = await axios.put(
        requestUrl,
        requestBody, // No need to manually stringify unless explicitly required
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${requestToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error(
        "Error fetching data:",
        error?.response?.data || error.message
      );

      // Optionally return a consistent error structure
      return {
        success: false,
        error: error?.response?.data || error.message,
      };
    }
  };

  try {
    let data = await fetchData(url, params);
    if (isTokenExpired(data)) {
      console.log("Token Expired! Refreshing...");
      const newAccessToken = await refreshToken(true); // reactive: this call just saw INVALID_OAUTHTOKEN
      if (!newAccessToken) {
        throw new Error("Failed to refresh token.");
      }
      data = await fetchData(url, params);
    }
    return data;
  } catch (error) {
    console.error("Error in createExportJob:", error);
  }
}

module.exports = {
  createExportJob,
  getJobData,
  handleZohoInventoryRequest,
  handleZohoInventoryPostRequest,
  handleZohoInventoryMultipartPostRequest,
  handleZohoInventoryPutRequest,
  getViewData,
  // Exported so callers that fan out many parallel Zoho requests can
  // proactively refresh once up front, avoiding the per-call reactive
  // refresh storm.
  refreshToken,
};
