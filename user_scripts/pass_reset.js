"use strict";
const mysql = require("promise-mysql");
const async = require("async");
const argv = require('minimist')(process.argv.slice(2));

if (!argv.user) {
	console.error("Please specify user address to delete");
	process.exit(1);
}
const user = argv.user;

require("../init_mini.js").init(function() {
	async.waterfall([
		function (callback) {
			global.mysql.query("SELECT * FROM users WHERE username = ?", [user]).then(function (rows) {
				if (rows.length != 1) {
					console.error("User was not found!");
					process.exit(1);
				}
				console.log("Found rows in users table: " + rows.length);
				callback();
			});
		},
		function (callback) {
			global.mysql.query("DELETE FROM users WHERE username = ?", [user]).then(function (rows) {
				console.log("DELETE FROM users WHERE username = " + user);
				callback();
			});
		},
		function (callback) {
			console.log("DONE: Please do not forget to restart your miner to apply new password and set payment thresold since it was reset as well");
			process.exit(0);
	        }
	]);
});