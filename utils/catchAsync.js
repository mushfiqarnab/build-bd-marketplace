// utils/catchAsync.js

/**
 * Wraps asynchronous Express middleware to catch errors and forward them to the global handler.
 * @param {Function} fn - Asynchronous route function
 */
module.exports = fn => {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
};