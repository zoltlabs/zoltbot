// Account identifiers come from the environment so forks never build or submit
// under the official Apple team, Firebase project or Expo project by accident.
module.exports = ({ config }) => {
  const teamId = process.env.APPLE_TEAM_ID;
  const projectId = process.env.EXPO_PROJECT_ID;
  // P9: Android pushes need the owner's Firebase file (an EAS file variable); without it the
  // app builds and runs with pushes off.
  const googleServices = process.env.GOOGLE_SERVICES_JSON;
  return {
    ...config,
    ios: { ...config.ios, ...(teamId ? { appleTeamId: teamId } : {}) },
    android: {
      ...config.android,
      ...(googleServices ? { googleServicesFile: googleServices } : {}),
    },
    extra: { ...config.extra, ...(projectId ? { eas: { ...config.extra?.eas, projectId } } : {}) },
  };
};
