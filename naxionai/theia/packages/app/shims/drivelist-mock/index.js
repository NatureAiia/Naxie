// Mock drivelist - returns empty array instead of native module
module.exports = {
    list: function (callback) {
        callback(null, []);
    },
    listSync: function () {
        return [];
    }
};
