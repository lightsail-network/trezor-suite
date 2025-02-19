import { ActionButton, ActionColumn, SectionItem, TextColumn } from 'src/components/suite';
import { goto } from '../../../actions/suite/routerActions';
import { SettingsAnchor } from '../../../constants/suite/anchors';
import { useDispatch } from '../../../hooks/suite';

export const TriggerHighlight = () => {
    const dispatch = useDispatch();

    return (
        <SectionItem data-test="@settings/debug/github">
            <TextColumn
                title="Trigger highlight"
                description="Goes to the anchor in the application and highlights it. This allows testing of this functionality with custom anchor."
            />
            <ActionColumn>
                <ActionButton
                    variant="secondary"
                    onClick={() =>
                        dispatch(
                            goto('settings-index', { anchor: SettingsAnchor.BitcoinAmountUnit }),
                        )
                    }
                >
                    Go to Bitcoin Unit Settings
                </ActionButton>
            </ActionColumn>
        </SectionItem>
    );
};
