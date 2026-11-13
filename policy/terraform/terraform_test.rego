# Unit tests for terraform.rego (`conftest verify`). Inputs mimic the hcl2
# parser's output, where blocks are lists of objects.
package main

import rego.v1

good_db := {
	"publicly_accessible": false,
	"storage_encrypted": true,
	"iam_database_authentication_enabled": true,
}

test_compliant_database_passes if {
	count(deny) == 0 with input as {"resource": {"aws_db_instance": {"main": [good_db]}}}
}

test_public_database_is_denied if {
	db := object.union(good_db, {"publicly_accessible": true})
	deny["aws_db_instance must not be publicly accessible"] with input as {"resource": {"aws_db_instance": {"main": [db]}}}
}

test_unencrypted_database_is_denied if {
	db := object.remove(good_db, ["storage_encrypted"])
	deny["aws_db_instance must set storage_encrypted = true"] with input as {"resource": {"aws_db_instance": {"main": [db]}}}
}

test_password_only_database_is_denied if {
	db := object.union(good_db, {"iam_database_authentication_enabled": false})
	deny["aws_db_instance must use IAM database authentication"] with input as {"resource": {"aws_db_instance": {"main": [db]}}}
}

test_blocks_given_as_an_object_are_checked_too if {
	db := object.union(good_db, {"publicly_accessible": true})
	deny["aws_db_instance must not be publicly accessible"] with input as {"resource": {"aws_db_instance": {"main": db}}}
}

test_ingress_from_a_cidr_is_denied if {
	rule := {"cidr_ipv4": "0.0.0.0/0", "from_port": 443, "to_port": 443}
	deny["security group ingress must not use cidr_ipv4; allow a security group or prefix list"] with input as {"resource": {"aws_vpc_security_group_ingress_rule": {"open": [rule]}}}
}

test_ingress_from_a_security_group_passes if {
	rule := {"referenced_security_group_id": "${aws_security_group.alb.id}", "from_port": 3000, "to_port": 3000}
	count(deny) == 0 with input as {"resource": {"aws_vpc_security_group_ingress_rule": {"app": [rule]}}}
}

test_egress_to_a_cidr_is_allowed if {
	rule := {"cidr_ipv4": "0.0.0.0/0", "from_port": 443, "to_port": 443}
	count(deny) == 0 with input as {"resource": {"aws_vpc_security_group_egress_rule": {"https": [rule]}}}
}

test_legacy_ingress_rule_with_cidr_is_denied if {
	rule := {"type": "ingress", "cidr_blocks": ["10.0.0.0/8"]}
	deny["security group ingress must not use cidr_blocks"] with input as {"resource": {"aws_security_group_rule": {"r": [rule]}}}
}

test_inline_ingress_with_cidr_is_denied if {
	group := {"ingress": [{"cidr_blocks": ["0.0.0.0/0"]}]}
	deny["security group ingress must not use cidr_blocks"] with input as {"resource": {"aws_security_group": {"g": [group]}}}
}

test_mutable_image_tags_are_denied if {
	deny["aws_ecr_repository must use IMMUTABLE tags"] with input as {"resource": {"aws_ecr_repository": {"app": [{"image_tag_mutability": "MUTABLE"}]}}}
}

test_immutable_image_tags_pass if {
	count(deny) == 0 with input as {"resource": {"aws_ecr_repository": {"app": [{"image_tag_mutability": "IMMUTABLE"}]}}}
}

test_provider_with_all_tags_passes if {
	provider := {"region": "${var.region}", "default_tags": [{"tags": {"project": "p", "environment": "e", "managed-by": "terraform"}}]}
	count(deny) == 0 with input as {"provider": {"aws": [provider]}}
}

test_provider_missing_a_tag_is_denied if {
	provider := {"default_tags": [{"tags": {"project": "p", "environment": "e"}}]}
	deny[`the aws provider's default_tags must include ["managed-by"]`] with input as {"provider": {"aws": [provider]}}
}

test_provider_without_default_tags_is_denied if {
	deny[`the aws provider's default_tags must include ["environment", "managed-by", "project"]`] with input as {"provider": {"aws": [{"region": "eu-west-2"}]}}
}
