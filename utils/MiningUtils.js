import { MiningUtils } from './MiningUtilsLegacy';

export { MiningUtils };

export const getMiningSpeed = (area) => MiningUtils.getMiningSpeed(area);
export const getSpeedWithCold = () => MiningUtils.getSpeedWithCold();
export const getMineTime = (pos, speed, boost) => MiningUtils.getMineTime(pos, speed, boost);
export const getBlockInfo = (registryName) => MiningUtils.getBlockInfo(registryName);
export const hasMaxGreatExplorer = () => MiningUtils.hasMaxGreatExplorer();
export const refreshMiningStatsIfNeeded = (callback = null) => MiningUtils.refreshMiningStatsIfNeeded(callback);
export const getDrills = () => MiningUtils.getDrills();
export const refuel = (callback, options = {}) => MiningUtils.doRefueling(false, callback, options);
export const getDebuff = (type) => MiningUtils.getDebuff(type);
export const setGhostBlock = (pos) => MiningUtils.GhostBlock(pos);
export const readCommissionsFromGui = (container, isKnownCommission) => MiningUtils.readCommissionsFromGui(container, isKnownCommission);
