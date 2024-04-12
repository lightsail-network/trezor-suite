import React from 'react';
import { DeviceAnimation } from '../animations/DeviceAnimation';
import { DeviceModelInternal } from '@trezor/connect';
import { Image } from '../Image/Image';

interface DeviceImageProps {
    deviceModel?: DeviceModelInternal;
    deviceColor?: number;
    className?: string;
    animationHeight?: string;
    animationWidth?: string;
}

export const RotateDeviceImage = ({
    deviceModel,
    deviceColor,
    className,
    animationHeight,
    animationWidth,
}: DeviceImageProps) => {
    if (!deviceModel) {
        return null;
    }

    const isDeviceImageRotating =
        deviceModel && [DeviceModelInternal.T3T1, DeviceModelInternal.T2B1].includes(deviceModel);

    return (
        <>
            {isDeviceImageRotating ? (
                <DeviceAnimation
                    className={className}
                    type="ROTATE"
                    deviceModelInternal={deviceModel}
                    deviceUnitColor={deviceColor}
                    height={animationHeight}
                    width={animationWidth}
                />
            ) : (
                <Image alt="Trezor" image={`TREZOR_${deviceModel}`} className={className} />
            )}
        </>
    );
};