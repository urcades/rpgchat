const calculateLinearLevel = (messageCount) => {
    return Math.floor(messageCount / 100);
  };
  
  const calculateExponentialLevel = (messageCount) => {
    return Math.floor(Math.log2(messageCount / 100 + 1));
  };
  
  const calculateQuadraticLevel = (messageCount) => {
    return Math.floor(Math.sqrt(messageCount / 100));
  };
  
  const calculateCustomLevel = (messageCount) => {
    return Math.floor(Math.pow(messageCount / 100, 1.5));
  };
  
  const calculateLevel = calculateLinearLevel; // Change this to the desired leveling function
  
  module.exports = {
    calculateLinearLevel,
    calculateExponentialLevel,
    calculateQuadraticLevel,
    calculateCustomLevel,
    calculateLevel
  };