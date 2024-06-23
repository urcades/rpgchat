const calculateLinearLevel = (experienceCount, experienceRequired) => {
  return Math.floor(experienceCount / experienceRequired);
};

const calculateExponentialLevel = (experienceCount, experienceRequired) => {
  return Math.floor(Math.log2(experienceCount / experienceRequired + 1));
};

const calculateQuadraticLevel = (experienceCount, experienceRequired) => {
  return Math.floor(Math.sqrt(experienceCount / experienceRequired));
};

const calculateCustomLevel = (experienceCount, experienceRequired) => {
  return Math.floor(Math.pow(experienceCount / experienceRequired, 1.5));
};

const calculateLevel = calculateLinearLevel;

const calculateLinearExperienceRequired = (level) => {
  return 100 * (level + 1);
};

const calculateExponentialExperienceRequired = (level) => {
  return Math.floor(100 * Math.pow(2, level));
};

const calculateQuadraticExperienceRequired = (level) => {
  return Math.floor(100 * Math.pow(level + 1, 2));
};

const calculateCustomExperienceRequired = (level) => {
  return Math.floor(100 * Math.pow(level + 1, 1.5));
};

const calculateExperienceRequired = calculateLinearExperienceRequired;

module.exports = {
  calculateLinearLevel,
  calculateExponentialLevel,
  calculateQuadraticLevel,
  calculateCustomLevel,
  calculateLevel,
  calculateLinearExperienceRequired,
  calculateExponentialExperienceRequired,
  calculateQuadraticExperienceRequired,
  calculateCustomExperienceRequired,
  calculateExperienceRequired
};