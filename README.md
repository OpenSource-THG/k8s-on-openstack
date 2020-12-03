# Kubernetes on OpenStack with self-provisioning

This contains two main directories, the first is the ansible which is executed directly on the hosts. The second, `pulumi-openstack` contains pulumi typescript to build the kubernetes hosts in the OpenStack environment

## Infrastructure

The bare vms + user accounts + local iptables/firewalld rules are configured via pulumi + ansible contained here.

## Releases

To make a 'release' of the infrastructure which will tag a version in github and creat a tarball for download as part of the provisioning of the VMs.

    GRGIT_USER='user' GRGIT_PASS='api_token' ./gradlew final

