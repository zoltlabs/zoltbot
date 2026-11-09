// Account identifiers come from the environment so forks never build or submit
// under the official Apple team or Expo project by accident.
module.exports = ({ config }) => {
  const teamId = process.env.APPLE_TEAM_ID;
  const projectId = process.env.EXPO_PROJECT_ID;
  return {
    ...config,
    ios: { ...config.ios, ...(teamId ? { appleTeamId: teamId } : {}) },
    extra: { ...config.extra, ...(projectId ? { eas: { ...config.extra?.eas, projectId } } : {}) },
  };
};
