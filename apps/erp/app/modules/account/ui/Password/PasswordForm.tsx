import { ValidatedForm } from "@carbon/form";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  VStack
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { Password, Submit } from "~/components/Form";
import { path } from "~/utils/path";
import { accountPasswordValidator } from "../../account.models";

type PasswordFormProps = {
  hasSetPassword: boolean;
};

const PasswordForm = ({ hasSetPassword }: PasswordFormProps) => {
  const { t } = useLingui();
  const [passwordsMatch, setPasswordsMatch] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);

  const onPasswordChange = () => {
    if (passwordRef.current && confirmPasswordRef.current) {
      setPasswordsMatch(
        passwordRef.current.value.length >= 6 &&
          confirmPasswordRef.current.value.length >= 6 &&
          passwordRef.current.value === confirmPasswordRef.current.value
      );
    }
  };

  return (
    <Card>
      <ValidatedForm
        method="post"
        action={path.to.accountPassword}
        validator={accountPasswordValidator}
      >
        <CardHeader>
          <CardTitle>
            {hasSetPassword ? (
              <Trans>Update Password</Trans>
            ) : (
              <Trans>Set Password</Trans>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <VStack spacing={4} className="my-4 max-w-[440px]">
            {hasSetPassword && (
              <Password name="currentPassword" label={t`Current Password`} />
            )}
            <Password
              ref={passwordRef}
              onChange={onPasswordChange}
              name="password"
              label={t`New Password`}
            />
            <Password
              ref={confirmPasswordRef}
              onChange={onPasswordChange}
              name="confirmPassword"
              label={t`Confirm Password`}
            />
          </VStack>
        </CardContent>
        <CardFooter>
          <Submit isDisabled={!passwordsMatch} withBlocker={false}>
            {hasSetPassword ? (
              <Trans>Update Password</Trans>
            ) : (
              <Trans>Set Password</Trans>
            )}
          </Submit>
        </CardFooter>
      </ValidatedForm>
    </Card>
  );
};

export default PasswordForm;
