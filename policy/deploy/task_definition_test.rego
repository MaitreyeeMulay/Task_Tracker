# Unit tests for task_definition.rego (`conftest verify`).
package main

import rego.v1

digest := "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

signed_image := concat("@", ["123456789012.dkr.ecr.eu-west-2.amazonaws.com/incident-tracker-dev", digest])

container(overrides) := object.union(
	{
		"name": "app",
		"image": signed_image,
		"readonlyRootFilesystem": true,
		"environment": [{"name": "DB_HOST", "value": "db"}],
		"secrets": [{"name": "SESSION_SECRET", "valueFrom": "arn:aws:ssm:eu-west-2:123456789012:parameter/x"}],
	},
	overrides,
)

task(containers) := {"networkMode": "awsvpc", "containerDefinitions": containers}

test_compliant_task_definition_passes if {
	count(deny) == 0 with input as task([container({})])
}

test_image_by_tag_is_denied if {
	img := "123456789012.dkr.ecr.eu-west-2.amazonaws.com/incident-tracker-dev:latest"
	count(deny) == 1 with input as task([container({"image": img})])
}

test_image_from_another_registry_is_denied if {
	img := concat("@", ["docker.io/library/node", digest])
	count(deny) == 1 with input as task([container({"image": img})])
}

test_placeholder_image_is_denied if {
	count(deny) == 1 with input as task([container({"image": "public.ecr.aws/docker/library/busybox:1.37.0"})])
}

test_writable_root_filesystem_is_denied if {
	deny[`container "app": readonlyRootFilesystem must be true`] with input as task([container({"readonlyRootFilesystem": false})])
}

test_privileged_container_is_denied if {
	deny[`container "app": privileged containers are not allowed`] with input as task([container({"privileged": true})])
}

test_secret_in_plain_environment_is_denied if {
	env := [{"name": "DB_PASSWORD", "value": "hunter2"}]
	deny[`container "app": DB_PASSWORD looks like a secret; pass it through secrets, not environment`] with input as task([container({"environment": env})])
}

test_every_container_is_checked if {
	worker := container({"name": "worker", "readonlyRootFilesystem": false})
	deny[`container "worker": readonlyRootFilesystem must be true`] with input as task([container({}), worker])
}

test_empty_task_definition_is_denied if {
	deny["task definition has no containers"] with input as {"networkMode": "awsvpc"}
}

test_other_network_mode_is_denied if {
	deny["networkMode must be awsvpc"] with input as {"networkMode": "bridge", "containerDefinitions": [container({})]}
}
