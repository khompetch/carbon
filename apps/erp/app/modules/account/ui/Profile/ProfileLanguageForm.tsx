import { ValidatedForm } from "@carbon/form";
import {
  getSortedLanguageSelectOptions,
  resolveLanguage
} from "@carbon/locale";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { Select, Submit } from "~/components/Form";
import { accountLanguageValidator } from "../../account.models";

const ProfileLanguageForm = ({ locale }: { locale: string }) => {
  const { t } = useLingui();

  const options = useMemo(
    () => getSortedLanguageSelectOptions(locale),
    [locale]
  );

  return (
    <ValidatedForm
      method="post"
      // Reuse the cookie-setting endpoint the avatar-menu switcher uses; the
      // root loader revalidates after submit and re-renders in the new locale.
      action="/api/locale"
      validator={accountLanguageValidator}
      defaultValues={{
        locale: resolveLanguage(locale)
      }}
      className="w-full"
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <Trans>Language</Trans>
          </CardTitle>
          <CardDescription>
            <Trans>Choose your preferred language for the interface.</Trans>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select name="locale" label={t`Language`} options={options} />
        </CardContent>
        <CardFooter>
          <Submit>
            <Trans>Save</Trans>
          </Submit>
        </CardFooter>
      </Card>
    </ValidatedForm>
  );
};

export default ProfileLanguageForm;
