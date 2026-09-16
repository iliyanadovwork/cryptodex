#!/usr/bin/perl
#
# logcap.pl - size-capped, rotating log sink for the Cryptodex stack.
#
# Usage:  <producer> 2>&1 | logcap.pl [--rotate-on-start] <logfile> <max_bytes> <keep_generations>
#
# --rotate-on-start rotates any existing non-empty log before the first write,
# so each boot of the stack starts with a clean file while the previous run is
# retained as <logfile>.1.
#
# Reads stdin line-by-line and appends to <logfile>. When the file exceeds
# <max_bytes> it is rotated: file.(N-1) -> file.N ... file -> file.1, and a
# fresh file is opened. Rotated generations beyond <keep_generations> are
# deleted, so total disk use is bounded at roughly max_bytes * (keep + 1).
#
# Why a pipe instead of truncating the file in place:
#   `nohup npm start > /tmp/x.log` opens the file WITHOUT O_APPEND, so the node
#   process keeps its own file offset. Truncating that file externally
#   (`: > /tmp/x.log`) does NOT reset the writer's offset - it just makes the
#   file sparse, and it immediately reports its old huge size again. Rotating
#   by rename has the same problem: the writer keeps the old inode and the
#   "new" log stays empty forever. Owning the file from a sink process on the
#   other end of a pipe is the only way to rotate correctly without touching
#   application code.
#
# Lifecycle: when the producer exits, this process sees EOF and exits too, so
# it never outlives the service it is logging for.

use strict;
use warnings;

my $rotate_on_start = 0;
if (@ARGV && $ARGV[0] eq '--rotate-on-start') {
    $rotate_on_start = 1;
    shift @ARGV;
}

my ($path, $max, $keep) = @ARGV;
die "usage: logcap.pl [--rotate-on-start] <logfile> <max_bytes> <keep_generations>\n"
    unless defined $path && defined $max && defined $keep;

$max  = int($max);
$keep = int($keep);
$max  = 1_048_576 if $max < 1_048_576;   # never cap below 1 MiB
$keep = 0 if $keep < 0;

my $fh;
my $size = 0;

sub open_log {
    open($fh, '>>', $path) or die "logcap: cannot open $path: $!\n";
    $fh->autoflush(1);
    $size = -s $path;
    $size = 0 unless defined $size;
}

sub rotate {
    close($fh) if $fh;
    # Drop the oldest generation, then shift each one down.
    unlink("$path.$keep") if $keep > 0 && -e "$path.$keep";
    for (my $i = $keep - 1; $i >= 1; $i--) {
        rename("$path.$i", "$path." . ($i + 1)) if -e "$path.$i";
    }
    if ($keep > 0) {
        rename($path, "$path.1");
    } else {
        unlink($path);
    }
    open_log();
}

if ($rotate_on_start && -s $path) {
    rotate();          # retires the previous run's log to <path>.1
} else {
    open_log();
}

# Ignore SIGPIPE/SIGHUP so a transient downstream problem never takes the
# service down; we exit on EOF instead.
$SIG{PIPE} = 'IGNORE';
$SIG{HUP}  = 'IGNORE';

while (my $line = <STDIN>) {
    print $fh $line;
    $size += length($line);
    rotate() if $size >= $max;
}

close($fh) if $fh;
exit 0;
