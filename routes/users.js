var express = require('express');
var router = express.Router();

/* GET users listing. */
router.get('/', function(req, res, next) {
  res.send('respond with a resource');
});

router.get("/getInfo", function(req,res,next){
  res.send(JSON.stringify({  user:{
    roles: ['admin'],
    userId: "Test ID",
    userName: "Admin",
    nickName: "Admin"
  }}))


  }
)

module.exports = router;
