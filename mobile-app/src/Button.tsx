import { Pressable, Text } from 'react-native';
import { styles } from './styles';

/** A small button: blue by default, `quiet` for secondary actions, `danger` for removing. */
export function Button(props: {
  title: string;
  onPress(): void;
  disabled?: boolean;
  kind?: 'quiet' | 'danger';
  testID?: string;
}) {
  return (
    <Pressable
      style={[
        styles.smallButton,
        props.kind === 'quiet' && styles.quietButton,
        props.kind === 'danger' && styles.dangerButton,
        props.disabled && styles.buttonDisabled,
      ]}
      disabled={props.disabled}
      onPress={props.onPress}
      testID={props.testID}
    >
      <Text style={[styles.smallButtonText, props.kind === 'quiet' && styles.quietButtonText]}>{props.title}</Text>
    </Pressable>
  );
}
