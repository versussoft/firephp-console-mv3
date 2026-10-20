<?php
require __DIR__.'/vendor/autoload.php';
use Monolog\Logger; use Monolog\Handler\FirePHPHandler; use Monolog\Handler\ChromePHPHandler;
$l = new Logger('app');
$l->pushHandler(new FirePHPHandler()); $l->pushHandler(new ChromePHPHandler());
$l->debug('debug msg', ['user'=>42]);
$l->warning('warn msg');
$l->error('err msg', ['exception'=>new LogicException('bad')]);
echo "ok";
