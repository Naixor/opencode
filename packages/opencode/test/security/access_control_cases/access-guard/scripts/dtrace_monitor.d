#!/usr/sbin/dtrace -s
/*
 * dtrace_monitor.d — DTrace alternative for filesystem monitoring
 *
 * Usage: sudo dtrace -s dtrace_monitor.d -p <pid>
 *
 * Probes syscall::open/read/write/unlink/rename filtered by $target pid.
 * Output format: timestamp|syscall|path|pid
 *
 * NOTE: On macOS 10.15+ (Catalina), DTrace may be restricted by SIP.
 * fs_usage is generally preferred for modern macOS filesystem monitoring.
 */

#pragma D option quiet
#pragma D option switchrate=10hz

dtrace:::BEGIN
{
  printf("# DTrace filesystem monitor started for PID %d\n", $target);
  printf("# Format: timestamp|syscall|path|pid\n");
}

/* open/openat — file read/write initiation */
syscall::open:entry,
syscall::openat:entry
/pid == $target/
{
  self->path = copyinstr(arg0);
}

syscall::open:return,
syscall::openat:return
/pid == $target && self->path != NULL/
{
  printf("%Y|open|%s|%d\n", walltimestamp, self->path, pid);
  self->path = NULL;
}

/* read/pread — data read from file descriptor */
syscall::read:entry,
syscall::pread:entry
/pid == $target/
{
  printf("%Y|read|fd=%d|%d\n", walltimestamp, arg0, pid);
}

/* write/pwrite — data write to file descriptor */
syscall::write:entry,
syscall::pwrite:entry
/pid == $target/
{
  printf("%Y|write|fd=%d|%d\n", walltimestamp, arg0, pid);
}

/* stat/lstat — file metadata access */
syscall::stat:entry,
syscall::stat64:entry,
syscall::lstat:entry,
syscall::lstat64:entry
/pid == $target/
{
  self->statpath = copyinstr(arg0);
}

syscall::stat:return,
syscall::stat64:return,
syscall::lstat:return,
syscall::lstat64:return
/pid == $target && self->statpath != NULL/
{
  printf("%Y|stat|%s|%d\n", walltimestamp, self->statpath, pid);
  self->statpath = NULL;
}

/* unlink — file deletion */
syscall::unlink:entry
/pid == $target/
{
  self->unlinkpath = copyinstr(arg0);
}

syscall::unlink:return
/pid == $target && self->unlinkpath != NULL/
{
  printf("%Y|unlink|%s|%d\n", walltimestamp, self->unlinkpath, pid);
  self->unlinkpath = NULL;
}

/* rename — file rename/move */
syscall::rename:entry
/pid == $target/
{
  self->renamefrom = copyinstr(arg0);
  self->renameto = copyinstr(arg1);
}

syscall::rename:return
/pid == $target && self->renamefrom != NULL/
{
  printf("%Y|rename|%s->%s|%d\n", walltimestamp, self->renamefrom, self->renameto, pid);
  self->renamefrom = NULL;
  self->renameto = NULL;
}

/* mkdir — directory creation */
syscall::mkdir:entry
/pid == $target/
{
  self->mkdirpath = copyinstr(arg0);
}

syscall::mkdir:return
/pid == $target && self->mkdirpath != NULL/
{
  printf("%Y|mkdir|%s|%d\n", walltimestamp, self->mkdirpath, pid);
  self->mkdirpath = NULL;
}

/* symlink — symlink creation */
syscall::symlink:entry
/pid == $target/
{
  self->symlinkfrom = copyinstr(arg0);
  self->symlinkto = copyinstr(arg1);
}

syscall::symlink:return
/pid == $target && self->symlinkfrom != NULL/
{
  printf("%Y|symlink|%s->%s|%d\n", walltimestamp, self->symlinkfrom, self->symlinkto, pid);
  self->symlinkfrom = NULL;
  self->symlinkto = NULL;
}

/* readlink — symlink resolution */
syscall::readlink:entry
/pid == $target/
{
  self->readlinkpath = copyinstr(arg0);
}

syscall::readlink:return
/pid == $target && self->readlinkpath != NULL/
{
  printf("%Y|readlink|%s|%d\n", walltimestamp, self->readlinkpath, pid);
  self->readlinkpath = NULL;
}

dtrace:::END
{
  printf("# DTrace filesystem monitor stopped\n");
}
