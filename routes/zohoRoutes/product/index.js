var express = require("express");
var axios = require("axios");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../../utils/mongodb");

const {
  getViewData,
  handleZohoInventoryRequest,
} = require("../../../utils/zohoRequest");

var productCollectionRoute = require("./routes/collections");

router.use("/collections", productCollectionRoute);

router.get("/searchProduct", async function (req, res, next) {
  const keyword = req.query.keyword;
  const domainName = process.env.DOMAIN_NAME;
  if (!keyword || !domainName) {
    res.status(200).send(
      JSON.stringify({
        code: -1,
        success: false,
        mgs: "Missing parameter",
      }),
    );
    return;
  }
  const searchUrl = `https://commerce.zoho.com/storefront/api/v1/search-products?q=${keyword}`;
  const searchResult = await axios.get(searchUrl, {
    headers: { "domain-name": domainName },
  });
  const data = searchResult.data;
  if (data.status_code == 0) {
    //success
    res.send(
      JSON.stringify({
        code: 0,
        success: true,
        msg: "",
        data: data.payload.products,
      }),
    );
  } else {
    res.status(200).send(
      JSON.stringify({
        code: -1,
        success: false,
        mgs: "Something is wrong.",
      }),
    );
  }
});


const priceListIdMap = {
  VIP: "2591985000000103001",
  SVIP: "2591985000078196985",
  Platinum: "2591985000001439015",
  WholeSale: "2591985000000103011",
};

router.get("/getProductDetail/:id", async function (req, res, next) {
  const { id } = req.params;
  const url = `https://www.zohoapis.com/inventory/v1/items/${id}?organization_id=746138234`;

  const productDetail = await handleZohoInventoryRequest(url);
const item = productDetail.item
const customFieldsMapped = Object.fromEntries(
  item.custom_fields.map(f => [f.label, f.value])
)

   const getPriceConfig = {
        responseFormat: "json",
        criteria: `"Product ID" = '${id}'`,
        selectedColumns: ["PriceList ID", "Product ID", "PriceList Rate"],
      };
      const encodedConfig = encodeURIComponent(JSON.stringify(getPriceConfig));
      const getPriceUrl = `https://analyticsapi.zoho.com/restapi/v2/workspaces/1404913000003936002/views/1404913000003936194/data?CONFIG=${encodedConfig}`;

      const priceListData = await getViewData(getPriceUrl);
const prices = Object.entries(priceListIdMap).reduce((acc, [key, id]) => {
  const found = priceListData.find(item => item["PriceList ID"] === id)

  acc[key.toLowerCase()] = found
    ? Number(
        found["PriceList Rate"]
          .replace("AUD", "")
          .replace(/,/g, "")
          .trim()
      )
    : null

  return acc
}, {})

  const date = new Date();
  date.setDate(date.getDate() - 90);
  const formattedDate = date.toISOString().split("T")[0];

 const zohoSalesconfig = {
    responseFormat: "json",
    selectedColumns: [ "Quantity", "Created Time"],
    criteria: `"Product ID" = '${id}' AND "Created Time" >= '${formattedDate}'`,
  };

  const zohoSalesEncoded = encodeURIComponent(JSON.stringify(zohoSalesconfig));
  const zohoSalesUrl = `https://analyticsapi.zoho.com/restapi/v2/workspaces/1404913000003936002/views/1404913000003936103/data?CONFIG=${zohoSalesEncoded}`;

  const zohoSalesData = await getViewData(zohoSalesUrl);

const result = {
    item_id: item.item_id,
    name: item.name,
    sku: item.sku,
    imgUrl: item.documents[0]?`https://www.imobilestore.com.au/product-images/${item.documents[0].file_name}/${item.documents[0].document_id}/600x600`:"",
    status: item.status,
    physicalStock: {    
          stockOnHand: item.actual_available_stock,
        commitedStock: item.actual_committed_stock,
        avaliableStock: item.actual_available_for_sale_stock,

    },
    priceList: prices,
    sales: zohoSalesData,
    ...customFieldsMapped
    

}
  return res.json(result);
});

module.exports = router;
