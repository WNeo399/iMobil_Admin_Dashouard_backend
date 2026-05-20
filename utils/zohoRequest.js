const axios = require("axios");
let requestToken ="";
const refresh_token = process.env.REFRESH_TOKEN;
const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;

const workspaceId = "1404913000003936002";

function isTokenExpired(data) {
  if (!data) return false;
  return (
    data.summary === "INVALID_OAUTHTOKEN" ||
    data.summary === "SECURITY_NEEDS_LOGIN" ||
    data.code === 14 ||
    data.code === 57 ||
    data.error?.code == 57 ||
    data.errorCode == 8535 ||
    data.errorCode == 7309
  );
}

async function refreshToken() {
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
    console.log("New Access Token:", requestToken);
    return requestToken;
  } catch (error) {
    console.error(
      "Error refreshing token:",
      error.response?.data || error.message
    );
  }
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
      const newAccessToken = await refreshToken(); // Ensure refreshToken returns the new token
      if (!newAccessToken) {
        throw new Error("Failed to refresh token.");
      }
      data = await fetchData(viewId);
    }
    console.log(data);
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
      const newAccessToken = await refreshToken(); // Ensure refreshToken returns the new token
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
      const newAccessToken = await refreshToken(); // Ensure refreshToken returns the new token
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
      const newAccessToken = await refreshToken(); // Ensure refreshToken returns the new token
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
    console.log(data);
    if (isTokenExpired(data)) {
      console.log("Token Expired! Refreshing...");
      const newAccessToken = await refreshToken(); // Ensure refreshToken returns the new token
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
  handleZohoInventoryPutRequest,
  getViewData,
};
