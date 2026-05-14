const categoriesQueryMap = {
  "iPhoneJK+Screen": `"Status" = 'Active' AND LOWER("Item Name")  LIKE '%jk+%' AND "Location" IS NOT NULL`,
  iPadScreen: `"Status" = 'Active' AND LOWER("Item Name")  LIKE '%ipad%' AND LOWER("Item Name") LIKE '%lcd touch digitizer screen%' AND "Location" IS NOT NULL`,
  macbookScreen: `"Status" = 'Active' AND LOWER("Item Name")  LIKE '%macbook%' AND LOWER("Item Name") LIKE '%lcd display assembly%' AND "Location" IS NOT NULL`,
  iPhoneJKScreen: `"Status" = 'Active' AND LOWER("Item Name")  LIKE '%[jk%' AND LOWER("Item Name") NOT LIKE '%jk+%' AND "Location" IS NOT NULL`,
  iPhoneIMBSoftOled: `"Status" = 'Active' AND LOWER("Item Name")  LIKE '%iphone%' AND LOWER("Item Name") LIKE '%[imb%' AND LOWER("Item Name") LIKE '%soft oled%' AND "Location" IS NOT NULL`,
  samsungAfScreen: `"Status" = 'Active' AND LOWER("Item Name")  LIKE '%samsung%' AND LOWER("Item Name") LIKE '%[aftermarket%' AND LOWER("Item Name") LIKE '%lcd touch digitizer screen%' AND "Location" IS NOT NULL`,
  samsungIMBScreen: `"Status" = 'Active' AND LOWER("Item Name")  LIKE '%samsung%' AND LOWER("Item Name") LIKE '%[imb%' AND LOWER("Item Name") LIKE '%lcd touch digitizer screen%' AND "Location" IS NOT NULL`,
  iPhoneBattery: `"Status" = 'Active' AND LOWER("Item Name")  LIKE '%iphone%' AND LOWER("Item Name") LIKE '%compatible battery%' AND LOWER("Item Name") NOT LIKE '%stickr%' AND "Location" IS NOT NULL`,
  samsungBattery: `"Status" = 'Active' AND LOWER("Item Name")  LIKE '%samsung%' AND LOWER("Item Name") LIKE '%compatible battery%' AND LOWER("Item Name") NOT LIKE '%stickr%' AND "Location" IS NOT NULL`,
  otherBattery: `"Status" = 'Active' AND LOWER("Item Name") NOT LIKE '%iphone%' AND LOWER("Item Name") NOT LIKE '%samsung%' AND LOWER("Item Name") LIKE '%compatible battery%' AND LOWER("Item Name") NOT LIKE '%stickr%' AND "Location" IS NOT NULL`,
  imbP01CNY: `"Status" = 'Active' AND "Prefer Vendor" = 'IMB-P01 CNY' AND "Location" IS NOT NULL`,
};

module.exports = {
  categoriesQueryMap,
};
