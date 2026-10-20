# GitLab-managed OpenTofu state, named "verify". Nothing is hardcoded here:
# the address, lock addresses and credentials come at init time from the
# TF_HTTP_* variables infra:plan sets (infra.gitlab-ci.yml):
#
#   TF_HTTP_ADDRESS=$CI_API_V4_URL/projects/$CI_PROJECT_ID/terraform/state/verify
#   TF_HTTP_LOCK_ADDRESS, TF_HTTP_UNLOCK_ADDRESS: the same URL + /lock
#   TF_HTTP_USERNAME=gitlab-ci-token, TF_HTTP_PASSWORD=$CI_JOB_TOKEN
#
# infra:check runs `tofu init -backend=false` and never touches the state.
terraform {
  backend "http" {}
}
