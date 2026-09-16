import { applyToPlayer } from '../../player/RotationGCD';

// Compatibility shim for Offline PathRotations. V5 5.2 folded the old
// PathRotationsUtility rotation state into the path rotation controller and
// RotationGCD. Keep only the two methods still referenced by the Offline
// pitch-jitter variant so legacy imports do not reintroduce the old state
// machine.
export const PathRotationsUtility = {
    applyRotationWithGCD(yaw, pitch) {
        return applyToPlayer(yaw, pitch);
    },

    stopRotation() {},
};
