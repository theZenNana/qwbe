# crm-pack exists twice, on purpose

The two cubes under this directory are byte-identical to the ones under
`core/store/crm-pack/cubes/`. That looks like a duplicate waiting to be deleted. It is not, and
deleting either copy breaks something that has no other way of being demonstrated.

## The two roads a cube can arrive by

`core/plugins/crm-pack/` is the **live plugin**. It is committed, and the kernel mounts it at
startup like any other plugin. This is what "a plugin that is simply present on disk" looks like.

`core/store/crm-pack/` is the **shelf copy**, and it carries the one file this directory does not:
`qwbe-package.json`, the package manifest. `POST /settings/packages/crm-pack/install` copies the
shelf copy into `core/plugins/`. This is the second road: a cube arriving at RUNTIME, without a
restart and without touching any file that was already there.

Same code, two arrival paths. One copy would prove only one of them.

## What breaks if you delete one

`probes/lifecycle-life.mjs` plays the whole life of a package from the shelf copy: install, check
that `core/plugins/crm-pack/cubes/contacts` appeared, use it, uninstall, check it is gone. Without
`core/store/crm-pack/` there is nothing to install, and the probe has no subject.

`probes/erp.mjs` needs the live copy for the opposite reason. `erp-pack` also brings a cube called
`contacts`, and the kernel REFUSES to install a package whose cube name is already mounted - that
refusal is itself a tested guarantee (see `probes/install.mjs`). So the ERP probe moves this
directory aside, installs its rival, and afterwards restores this one **exactly as committed**,
because a probe that leaves `core/plugins/` rearranged hands the next person a `git status` that
blames them for changes they did not make.

## If you are here to reduce duplication

The honest options are to generate one copy from the other at build time, or to teach the store to
install from an already-mounted plugin. Both are real work with real trade-offs. Copying the
directory is the cheap version, and the cost of the cheap version is this README.
